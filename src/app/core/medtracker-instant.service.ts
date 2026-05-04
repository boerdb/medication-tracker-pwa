import { Injectable, NgZone } from '@angular/core';
import { init } from '@instantdb/core';
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

  private db: ReturnType<typeof init> | null = null;
  private unsubscribeQuery: (() => void) | null = null;
  private started = false;
  private migrationAttempted = false;
  private lastMedIds = new Set<string>();
  private lastLogIds = new Set<string>();

  constructor(private zone: NgZone) {
    this.useCloud = Boolean(environment.instantAppId?.trim());
  }

  isConfigured(): boolean {
    return this.useCloud;
  }

  async start(
    onData: (payload: { medications: Medication[]; logs: LogEntry[] }) => void,
    onError: (message: string) => void,
  ): Promise<void> {
    if (!this.useCloud || this.started) return;
    this.started = true;

    const appId = environment.instantAppId!.trim();
    this.db = init({
      appId,
      schema: medtrackerInstantSchema,
      useDateObjects: false,
    });

    try {
      await this.db.auth.signInAsGuest();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Aanmelden bij InstantDB mislukt.';
      onError(msg);
      return;
    }

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
              await this.pushMigrationToCloud(localMeds, localLogs);
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

  stop(): void {
    this.unsubscribeQuery?.();
    this.unsubscribeQuery = null;
    this.db = null;
    this.started = false;
    this.migrationAttempted = false;
  }

  async persistMedications(meds: Medication[]): Promise<void> {
    if (!this.db) return;
    localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(meds));

    const nextIds = new Set(meds.map((m) => m.id));
    const txs = [];

    for (const existingId of this.lastMedIds) {
      if (!nextIds.has(existingId)) {
        txs.push(this.db.tx['medications'][existingId].delete());
      }
    }

    for (const m of meds) {
      txs.push(
        this.db.tx['medications'][m.id].update({
          name: m.name,
          times: m.times,
          stockCount: m.stockCount,
        }),
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
    localStorage.setItem(LOGS_KEY, JSON.stringify(logs));

    const nextIds = new Set(logs.map((l) => l.id));
    const txs = [];

    for (const existingId of this.lastLogIds) {
      if (!nextIds.has(existingId)) {
        txs.push(this.db.tx['logEntries'][existingId].delete());
      }
    }

    for (const entry of logs) {
      txs.push(
        this.db.tx['logEntries'][entry.id].update({
          medicationId: entry.medicationId,
          medicationName: entry.medicationName,
          dateKey: entry.dateKey,
          time: entry.time,
          status: entry.status,
          updatedAt: entry.updatedAt,
        }),
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

  private async pushMigrationToCloud(localMeds: Medication[], localLogs: LogEntry[]): Promise<void> {
    if (!this.db) return;

    const medTxs = localMeds.map((m) =>
      this.db!.tx['medications'][m.id].update({
        name: m.name,
        times: m.times,
        stockCount: m.stockCount,
      }),
    );

    const logTxs = localLogs.map((entry) =>
      this.db!.tx['logEntries'][entry.id].update({
        medicationId: entry.medicationId,
        medicationName: entry.medicationName,
        dateKey: entry.dateKey,
        time: entry.time,
        status: entry.status,
        updatedAt: entry.updatedAt,
      }),
    );

    await this.db.transact([...medTxs, ...logTxs]);
  }
}
