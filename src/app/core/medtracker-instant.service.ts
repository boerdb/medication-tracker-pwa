import { Injectable, NgZone } from '@angular/core';
import { init } from '@instantdb/core';
import type { User } from '@instantdb/core';
import { environment } from '../../environments/environment';
import { LOGS_KEY, MEDICATIONS_KEY } from './reminder-sync';
import type { LogEntry, Medication } from './medtracker-model';
import { medtrackerInstantSchema } from './medtracker-instant-schema';

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type InstantMedicationRow = {
  id: string;
  name: string;
  times: string[];
  stockCount: number | null;
};

type InstantLogRow = {
  id: string;
  medicationId: string;
  medicationName: string;
  dateKey: string;
  time: string;
  status: string;
  updatedAt: string;
};

@Injectable({ providedIn: 'root' })
export class MedtrackerInstantService {
  readonly useCloud: boolean;

  /** Na eerste auth-check (getAuth + subscribeAuth geïnstalleerd). */
  cloudAuthChecked = false;
  /** Ingeladen gebruiker; null = niet ingelogd (toon login). */
  cloudSessionUser: User | null = null;

  private db: ReturnType<typeof init> | null = null;
  private unsubscribeQuery: (() => void) | null = null;
  private unsubscribeAuth: (() => void) | null = null;
  private cloudBootstrapStarted = false;
  private migrationAttempted = false;
  private activeSyncUserId: string | null = null;
  private lastMedIds = new Set<string>();
  private lastLogIds = new Set<string>();

  private onDataCallback: ((payload: { medications: Medication[]; logs: LogEntry[] }) => void) | null =
    null;
  private onErrorCallback: ((message: string) => void) | null = null;

  constructor(private zone: NgZone) {
    this.useCloud = Boolean(environment.instantAppId?.trim());
  }

  isConfigured(): boolean {
    return this.useCloud;
  }

  get cloudNeedsLogin(): boolean {
    return this.useCloud && this.cloudAuthChecked && !this.cloudSessionUser?.id;
  }

  async start(
    onData: (payload: { medications: Medication[]; logs: LogEntry[] }) => void,
    onError: (message: string) => void,
    onAuthResolved?: () => void,
  ): Promise<void> {
    if (!this.useCloud || this.cloudBootstrapStarted) return;
    this.cloudBootstrapStarted = true;

    this.onDataCallback = onData;
    this.onErrorCallback = onError;

    this.ensureDb();

    const finishAuthUi = () => {
      this.zone.run(() => {
        this.cloudAuthChecked = true;
        onAuthResolved?.();
      });
    };

    try {
      const initial = await this.db!.getAuth();
      this.applySessionUser(initial);

      this.unsubscribeAuth = this.db!.subscribeAuth((auth) => {
        if (auth.error) {
          this.zone.run(() => this.onErrorCallback?.(auth.error.message));
          return;
        }
        this.applySessionUser(auth.user ?? null);
      });

      finishAuthUi();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'InstantDB kon niet worden gestart.';
      this.zone.run(() => this.onErrorCallback?.(msg));
      finishAuthUi();
    }
  }

  private applySessionUser(user: User | null): void {
    const prevId = this.cloudSessionUser?.id ?? null;
    const nextId = user?.id ?? null;

    this.zone.run(() => {
      this.cloudSessionUser = user;
    });

    if (prevId !== nextId) {
      this.teardownQueryOnly();
      this.migrationAttempted = false;
      this.activeSyncUserId = null;
    }

    if (nextId && this.onDataCallback && this.onErrorCallback) {
      this.ensureCloudSync(nextId);
    }
  }

  private ensureCloudSync(userId: string): void {
    const onData = this.onDataCallback;
    const onError = this.onErrorCallback;
    if (!this.db || !onData || !onError || !userId) return;
    if (this.activeSyncUserId === userId && this.unsubscribeQuery) return;

    this.teardownQueryOnly();
    this.activeSyncUserId = userId;

    this.unsubscribeQuery = this.db.subscribeQuery({ medications: {}, logEntries: {} }, (resp) => {
      if (resp.error) {
        this.zone.run(() => onError(resp.error.message));
        return;
      }
      if (!resp.data) return;

      void (async () => {
        const medRows = (resp.data!.medications ?? []) as InstantMedicationRow[];
        const logRows = (resp.data!.logEntries ?? []) as InstantLogRow[];

        if (!this.migrationAttempted && medRows.length === 0 && logRows.length === 0) {
          const localMeds = parseJson<Medication[]>(localStorage.getItem(MEDICATIONS_KEY), []);
          const localLogs = parseJson<LogEntry[]>(localStorage.getItem(LOGS_KEY), []);
          if (localMeds.length > 0 || localLogs.length > 0) {
            this.migrationAttempted = true;
            try {
              await this.pushMigrationToCloud(userId, localMeds, localLogs);
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'Migratie naar InstantDB mislukt.';
              this.zone.run(() => onError(msg));
            }
            return;
          }
          this.migrationAttempted = true;
        } else if (!this.migrationAttempted) {
          this.migrationAttempted = true;
        }

        const medications: Medication[] = medRows
          .map((row) => ({
            id: row.id,
            name: row.name,
            times: Array.isArray(row.times) ? row.times : [],
            stockCount:
              row.stockCount === undefined ? null : row.stockCount === null ? null : Number(row.stockCount),
          }))
          .map((m) => ({
            ...m,
            stockCount:
              m.stockCount !== null && (!Number.isFinite(m.stockCount) || m.stockCount < 0)
                ? null
                : m.stockCount,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        const logs: LogEntry[] = logRows
          .filter((row) => row.status === 'taken' || row.status === 'skipped')
          .map((row) => ({
            id: row.id,
            medicationId: row.medicationId,
            medicationName: row.medicationName,
            dateKey: row.dateKey,
            time: row.time,
            status: row.status as 'taken' | 'skipped',
            updatedAt: row.updatedAt,
          }));

        this.lastMedIds = new Set(medications.map((m) => m.id));
        this.lastLogIds = new Set(logs.map((l) => l.id));

        this.mirrorLocalStorage(medications, logs);

        this.zone.run(() => onData({ medications, logs }));
      })();
    });
  }

  private teardownQueryOnly(): void {
    this.unsubscribeQuery?.();
    this.unsubscribeQuery = null;
  }

  stop(): void {
    this.teardownQueryOnly();
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.db = null;
    this.cloudBootstrapStarted = false;
    this.activeSyncUserId = null;
    this.migrationAttempted = false;
    this.onDataCallback = null;
    this.onErrorCallback = null;
  }

  private ensureDb(): void {
    if (this.db) return;
    const appId = environment.instantAppId!.trim();
    this.db = init({
      appId,
      schema: medtrackerInstantSchema,
      useDateObjects: false,
      devtool: environment.instantDevtools,
    });
  }

  async sendLoginCode(email: string): Promise<void> {
    this.ensureDb();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) throw new Error('Vul een e-mailadres in.');
    await this.db!.auth.sendMagicCode({ email: trimmed });
  }

  async signInWithEmailCode(email: string, code: string): Promise<void> {
    this.ensureDb();
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedCode = code.trim();
    if (!trimmedEmail || !trimmedCode) throw new Error('E-mail en code zijn verplicht.');
    await this.db!.auth.signInWithMagicCode({ email: trimmedEmail, code: trimmedCode });
  }

  async signInAsGuestDevice(): Promise<void> {
    this.ensureDb();
    await this.db!.auth.signInAsGuest();
  }

  async signOutCloud(): Promise<void> {
    if (!this.db) return;
    await this.db.auth.signOut();
    this.clearMirroredLocalKeys();
    this.teardownQueryOnly();
    this.activeSyncUserId = null;
    this.migrationAttempted = false;
    this.lastMedIds = new Set();
    this.lastLogIds = new Set();
    this.zone.run(() => {
      this.cloudSessionUser = null;
    });
  }

  private clearMirroredLocalKeys(): void {
    localStorage.removeItem(MEDICATIONS_KEY);
    localStorage.removeItem(LOGS_KEY);
  }

  async persistMedications(meds: Medication[]): Promise<void> {
    if (!this.db) return;
    const ownerId = this.cloudSessionUser?.id;
    if (!ownerId) return;

    localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(meds));

    const nextIds = new Set(meds.map((m) => m.id));
    const txs = [];

    const txMeds = this.db.tx['medications'];
    for (const existingId of this.lastMedIds) {
      if (!nextIds.has(existingId)) {
        txs.push(txMeds[existingId].delete());
      }
    }

    for (const m of meds) {
      txs.push(
        txMeds[m.id].update({
          name: m.name,
          times: m.times,
          stockCount: m.stockCount,
        }),
        txMeds[m.id].link({ owner: ownerId }),
      );
    }

    if (txs.length === 0) {
      this.lastMedIds = nextIds;
      return;
    }
    await this.db.transact(txs);
    this.lastMedIds = nextIds;
  }

  async persistLogs(logs: LogEntry[]): Promise<void> {
    if (!this.db) return;
    const ownerId = this.cloudSessionUser?.id;
    if (!ownerId) return;

    localStorage.setItem(LOGS_KEY, JSON.stringify(logs));

    const nextIds = new Set(logs.map((l) => l.id));
    const txs = [];

    const txLogs = this.db.tx['logEntries'];
    for (const existingId of this.lastLogIds) {
      if (!nextIds.has(existingId)) {
        txs.push(txLogs[existingId].delete());
      }
    }

    for (const entry of logs) {
      txs.push(
        txLogs[entry.id].update({
          medicationId: entry.medicationId,
          medicationName: entry.medicationName,
          dateKey: entry.dateKey,
          time: entry.time,
          status: entry.status,
          updatedAt: entry.updatedAt,
        }),
        txLogs[entry.id].link({ owner: ownerId }),
      );
    }

    if (txs.length === 0) {
      this.lastLogIds = nextIds;
      return;
    }
    await this.db.transact(txs);
    this.lastLogIds = nextIds;
  }

  /** Volledige vervanging (bijv. import uit JSON). */
  async replaceAllFromBackup(medications: Medication[], logs: LogEntry[]): Promise<void> {
    await this.persistMedications(medications);
    await this.persistLogs(logs);
  }

  private mirrorLocalStorage(medications: Medication[], logs: LogEntry[]): void {
    localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(medications));
    localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
  }

  private async pushMigrationToCloud(
    ownerId: string,
    localMeds: Medication[],
    localLogs: LogEntry[],
  ): Promise<void> {
    if (!this.db) return;

    const txMeds = this.db.tx['medications'];
    const txLogs = this.db.tx['logEntries'];
    const medTxs = [];
    for (const m of localMeds) {
      medTxs.push(
        txMeds[m.id].update({
          name: m.name,
          times: m.times,
          stockCount: m.stockCount,
        }),
        txMeds[m.id].link({ owner: ownerId }),
      );
    }

    const logTxs = [];
    for (const entry of localLogs) {
      logTxs.push(
        txLogs[entry.id].update({
          medicationId: entry.medicationId,
          medicationName: entry.medicationName,
          dateKey: entry.dateKey,
          time: entry.time,
          status: entry.status,
          updatedAt: entry.updatedAt,
        }),
        txLogs[entry.id].link({ owner: ownerId }),
      );
    }

    await this.db.transact([...medTxs, ...logTxs]);
  }
}
