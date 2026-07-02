import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { buildMedtrackerBackupJson, parseMedtrackerBackupJson } from '../core/backup';
import { MedtrackerInstantService } from '../core/medtracker-instant.service';
import type { LogEntry, Medication } from '../core/medtracker-model';
import {
  getNotificationsEnabled,
  persistNotificationsEnabled,
  requestNotificationPermission,
  showLowStockNotification,
  showMedicationNotification,
} from '../core/notification-prefs';
import {
  LOGS_KEY,
  MEDICATIONS_KEY,
  REMINDER_FLAGS_KEY,
  mergeReminderFlagRecords,
  mergeReminderFlagsFromCache,
  registerPeriodicReminderSync,
  syncReminderBundleToCache,
  unregisterPeriodicReminderSync,
} from '../core/reminder-sync';
import { runReminderTick, slotKey, type ReminderFlags } from '../core/reminder-logic';

type Tab = 'today' | 'manage' | 'history';
type Status = 'taken' | 'skipped';
type DoseUnit = 'mg' | 'g' | 'µg';

type MedicationLike = {
  id: string;
  name: string;
  times: string[];
  stockCount?: number | null;
};

type HistoryDayGroup = {
  dateKey: string;
  label: string;
  entries: LogEntry[];
  takenCount: number;
  skippedCount: number;
  expectedCount: number;
  allTaken: boolean;
};

const HISTORY_DAYS_TO_KEEP = 15;
const LOW_STOCK_ALERTS_KEY = 'medtracker:lowStockAlerts';

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseDateKey(dateKey: string): Date | null {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  return new Date(year, month, day, 0, 0, 0, 0);
}

function startOfDayLocal(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function pruneHistoryLogs(logs: LogEntry[], now = new Date()): LogEntry[] {
  const cutoff = startOfDayLocal(now);
  cutoff.setDate(cutoff.getDate() - (HISTORY_DAYS_TO_KEEP - 1));

  return logs.filter((item) => {
    const logDate = parseDateKey(item.dateKey) ?? startOfDayLocal(new Date(item.updatedAt));
    return Number.isFinite(logDate.getTime()) && logDate >= cutoff;
  });
}

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeMedication(raw: MedicationLike): Medication {
  const parsedStock = Number(raw.stockCount);
  const stockCount = Number.isFinite(parsedStock) && parsedStock >= 0 ? Math.floor(parsedStock) : null;
  return {
    ...raw,
    stockCount,
  };
}

function formatDateKey(dateKey: string): string {
  const date = parseDateKey(dateKey);
  if (!date) return dateKey;
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

const todayKey = () => toLocalDateKey(new Date());

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

async function playTone(durationMs = 130, frequency = 880, volume = 0.12): Promise<void> {
  const ctx = getAudioContext();
  try {
    if (ctx.state === 'suspended') await ctx.resume();
  } catch {
    return;
  }

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = frequency;
  osc.type = 'sine';
  const t0 = ctx.currentTime;
  const dur = durationMs / 1000;
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur);

  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function playBeeps(count: number, gapMs = 220): Promise<void> {
  for (let i = 0; i < count; i++) {
    await playTone();
    if (i < count - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
}

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage implements OnInit, OnDestroy {
  @ViewChild('importInput') importInputRef?: ElementRef<HTMLInputElement>;

  constructor(
    readonly instant: MedtrackerInstantService,
    private cdr: ChangeDetectorRef,
  ) {
    this.instantLoading = this.instant.useCloud;
    if (!this.instant.useCloud) {
      this.medications = parseJson<Medication[]>(localStorage.getItem(MEDICATIONS_KEY), []).map(
        normalizeMedication,
      );
      this.logs = pruneHistoryLogs(parseJson<LogEntry[]>(localStorage.getItem(LOGS_KEY), []));
    }
  }

  readonly historyDaysToKeep = HISTORY_DAYS_TO_KEEP;
  tab: Tab = 'today';
  instantLoading: boolean;
  instantError: string | null = null;
  medications: Medication[] = [];
  logs: LogEntry[] = [];

  loginEmail = '';
  loginCode = '';
  loginBusy = false;
  loginHint: string | null = null;
  codeSent = false;

  newMedicationName = '';
  newMedicationDose = '';
  newMedicationDoseUnit: DoseUnit = 'mg';
  readonly doseUnitOptions: Array<{ value: DoseUnit; label: string }> = [
    { value: 'mg', label: 'mg' },
    { value: 'g', label: 'g' },
    { value: 'µg', label: 'µg' },
  ];
  newTime = '';
  newMedicationStock = '';
  newMedicationTimes: string[] = [];
  newTimeByMedication: Record<string, string> = {};
  renamingMedicationId: string | null = null;
  renameDraft = '';
  notificationsEnabled = getNotificationsEnabled();

  private flags: ReminderFlags = parseJson<ReminderFlags>(localStorage.getItem(REMINDER_FLAGS_KEY), {});
  private reminderIntervalId: number | null = null;
  private lowStockAlerts = parseJson<Record<string, boolean>>(localStorage.getItem(LOW_STOCK_ALERTS_KEY), {});
  private pointerUnlockHandler = () => {
    void getAudioContext().resume().catch(() => undefined);
  };
  private visibilityHandler = () => {
    if (document.visibilityState === 'visible') void this.mergeFlagsFromCache();
  };
  private focusHandler = () => void this.mergeFlagsFromCache();

  ngOnInit(): void {
    if (this.instant.useCloud) {
      void this.instant.start(
        ({ medications, logs }) => {
          this.medications = medications.map(normalizeMedication);
          const pruned = pruneHistoryLogs(logs);
          this.logs = pruned;
          if (pruned.length < logs.length) {
            void this.instant.persistLogs(pruned);
          }
          this.instantLoading = false;
          this.instantError = null;
          this.cdr.markForCheck();
        },
        (message) => {
          this.instantError = message;
          this.instantLoading = false;
          this.cdr.markForCheck();
        },
        () => {
          if (this.instant.cloudNeedsLogin) {
            this.instantLoading = false;
          }
          this.cdr.markForCheck();
        },
      );
    } else {
      this.saveLogs(this.logs);
    }
    document.addEventListener('pointerdown', this.pointerUnlockHandler, { once: true });
    void this.mergeFlagsFromCache();
    void this.syncReminders();
    this.reconcilePeriodicSync();
    this.tickReminders();
    this.reminderIntervalId = window.setInterval(() => this.tickReminders(), 15_000);

    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('focus', this.focusHandler);
  }

  ngOnDestroy(): void {
    document.removeEventListener('pointerdown', this.pointerUnlockHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    window.removeEventListener('focus', this.focusHandler);
    if (this.reminderIntervalId !== null) {
      window.clearInterval(this.reminderIntervalId);
    }
  }

  get showCloudAuthSpinner(): boolean {
    return this.instant.useCloud && !this.instant.cloudAuthChecked;
  }

  get showCloudLogin(): boolean {
    return this.instant.cloudNeedsLogin;
  }

  /** Hoofdscherm (tabs + medicatie): na auth-check en bij ingelogde sessie, of zonder cloud. */
  get showMedicationApp(): boolean {
    return !this.instant.useCloud || (this.instant.cloudAuthChecked && !this.instant.cloudNeedsLogin);
  }

  get todayLabel(): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date());
  }

  get notificationPermission(): NotificationPermission | 'unsupported' {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  }

  get todaySchedules(): Array<{
    id: string;
    medicationId: string;
    medicationName: string;
    time: string;
    status?: Status;
  }> {
    const key = todayKey();
    const statusBySlot = new Map(
      this.logs
        .filter((item) => item.dateKey === key)
        .map((item) => [`${item.medicationId}::${item.time}`, item.status]),
    );

    const schedules: Array<{
      id: string;
      medicationId: string;
      medicationName: string;
      time: string;
      status?: Status;
    }> = [];

    this.medications.forEach((medication) => {
      medication.times.forEach((time) => {
        schedules.push({
          id: `${medication.id}-${time}`,
          medicationId: medication.id,
          medicationName: medication.name,
          time,
          status: statusBySlot.get(`${medication.id}::${time}`),
        });
      });
    });

    return schedules.sort((a, b) => a.time.localeCompare(b.time));
  }

  get historyRows(): LogEntry[] {
    return [...this.logs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get historyTaken(): number {
    return this.historyRows.filter((item) => item.status === 'taken').length;
  }

  get historySkipped(): number {
    return this.historyRows.filter((item) => item.status === 'skipped').length;
  }

  get inventoryRows(): Array<{
    medicationId: string;
    medicationName: string;
    stockCount: number | null;
    dailyUsage: number;
    daysLeft: number | null;
    isLowStock: boolean;
  }> {
    return this.medications
      .map((medication) => {
        const dailyUsage = medication.times.length;
        const daysLeft =
          medication.stockCount === null || dailyUsage === 0
            ? null
            : Math.floor(medication.stockCount / dailyUsage);
        const isLowStock = daysLeft !== null && daysLeft <= 7;

        return {
          medicationId: medication.id,
          medicationName: medication.name,
          stockCount: medication.stockCount,
          dailyUsage,
          daysLeft,
          isLowStock,
        };
      })
      .sort((a, b) => a.medicationName.localeCompare(b.medicationName));
  }

  get lowStockRows(): Array<{
    medicationId: string;
    medicationName: string;
    stockCount: number | null;
    dailyUsage: number;
    daysLeft: number | null;
    isLowStock: boolean;
  }> {
    return this.inventoryRows.filter((item) => item.isLowStock);
  }

  inventoryForMedication(medicationId: string): {
    medicationId: string;
    medicationName: string;
    stockCount: number | null;
    dailyUsage: number;
    daysLeft: number | null;
    isLowStock: boolean;
  } | null {
    return this.inventoryRows.find((item) => item.medicationId === medicationId) ?? null;
  }

  get historyDays(): HistoryDayGroup[] {
    const expectedCount = this.medications.reduce((sum, medication) => sum + medication.times.length, 0);
    const rowsByDate = new Map<string, LogEntry[]>();

    this.historyRows.forEach((row) => {
      const current = rowsByDate.get(row.dateKey) ?? [];
      current.push(row);
      rowsByDate.set(row.dateKey, current);
    });

    const days: HistoryDayGroup[] = [];
    const baseDate = startOfDayLocal(new Date());

    for (let offset = 0; offset < this.historyDaysToKeep; offset++) {
      const date = new Date(baseDate);
      date.setDate(baseDate.getDate() - offset);
      const dateKey = toLocalDateKey(date);
      const entries = [...(rowsByDate.get(dateKey) ?? [])].sort((a, b) => a.time.localeCompare(b.time));
      const takenCount = entries.filter((item) => item.status === 'taken').length;
      const skippedCount = entries.filter((item) => item.status === 'skipped').length;
      const allTaken = expectedCount > 0 && takenCount === expectedCount && skippedCount === 0;

      days.push({
        dateKey,
        label: formatDateKey(dateKey),
        entries,
        takenCount,
        skippedCount,
        expectedCount,
        allTaken,
      });
    }

    return days;
  }

  private saveFlags(): void {
    localStorage.setItem(REMINDER_FLAGS_KEY, JSON.stringify(this.flags));
  }

  private saveLowStockAlerts(): void {
    localStorage.setItem(LOW_STOCK_ALERTS_KEY, JSON.stringify(this.lowStockAlerts));
  }

  private pruneLowStockAlerts(now = new Date()): void {
    const cutoff = startOfDayLocal(now);
    cutoff.setDate(cutoff.getDate() - (HISTORY_DAYS_TO_KEEP - 1));
    const next: Record<string, boolean> = {};

    Object.entries(this.lowStockAlerts).forEach(([dateKey, notified]) => {
      if (!notified) return;
      const parsed = parseDateKey(dateKey);
      if (!parsed) return;
      if (startOfDayLocal(parsed) >= cutoff) {
        next[dateKey] = true;
      }
    });

    this.lowStockAlerts = next;
    this.saveLowStockAlerts();
  }

  private saveMedications(next: Medication[]): void {
    const normalized = next.map(normalizeMedication);
    this.medications = normalized;
    if (this.instant.useCloud) {
      void this.instant.persistMedications(normalized);
    } else {
      localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(normalized));
    }
    void this.syncReminders();
  }

  private saveLogs(next: LogEntry[]): void {
    const pruned = pruneHistoryLogs(next);
    this.logs = pruned;
    if (this.instant.useCloud) {
      void this.instant.persistLogs(pruned);
    } else {
      localStorage.setItem(LOGS_KEY, JSON.stringify(pruned));
    }
    void this.syncReminders();
  }

  private async syncReminders(): Promise<void> {
    await syncReminderBundleToCache();
  }

  private async mergeFlagsFromCache(): Promise<void> {
    const remote = await mergeReminderFlagsFromCache();
    if (!remote) return;
    this.flags = mergeReminderFlagRecords(this.flags, remote);
    this.saveFlags();
  }

  private reconcilePeriodicSync(): void {
    if (
      this.notificationsEnabled &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      void registerPeriodicReminderSync();
    } else {
      void unregisterPeriodicReminderSync();
    }
  }

  private tickReminders(): void {
    this.pruneLowStockAlerts();
    const dateKey = todayKey();
    const { nextFlags, events } = runReminderTick({
      now: Date.now(),
      dateKey,
      medications: this.medications,
      logs: this.logs,
      flags: this.flags,
    });

    this.flags = nextFlags;
    this.saveFlags();
    void this.syncReminders();
    void this.notifyLowStockIfNeeded();

    void (async () => {
      for (const ev of events) {
        if (ev.kind === 'first') {
          await playBeeps(1);
          if (this.notificationsEnabled) {
            await showMedicationNotification(
              ev.medicationName,
              ev.time,
              'first',
              slotKey(dateKey, ev.medicationId, ev.time),
            );
          }
        } else {
          await playBeeps(2);
          if (this.notificationsEnabled) {
            await showMedicationNotification(
              ev.medicationName,
              ev.time,
              'second',
              slotKey(dateKey, ev.medicationId, ev.time),
            );
          }
        }
      }
    })();
  }

  private async notifyLowStockIfNeeded(): Promise<void> {
    if (!this.notificationsEnabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    const dateKey = todayKey();
    if (this.lowStockAlerts[dateKey]) return;

    const lowStockItems = this.lowStockRows
      .filter((item) => item.stockCount !== null && item.daysLeft !== null)
      .map((item) => ({
        medicationName: item.medicationName,
        stockCount: item.stockCount as number,
        daysLeft: item.daysLeft as number,
      }));

    if (lowStockItems.length === 0) return;

    await showLowStockNotification(dateKey, lowStockItems);
    this.lowStockAlerts = { ...this.lowStockAlerts, [dateKey]: true };
    this.saveLowStockAlerts();
  }

  async handleNotificationsToggle(checked: boolean): Promise<void> {
    if (checked) {
      const p = await requestNotificationPermission();
      if (p !== 'granted') return;
      persistNotificationsEnabled(true);
      this.notificationsEnabled = true;
      await registerPeriodicReminderSync();
      await this.syncReminders();
      await this.notifyLowStockIfNeeded();
      return;
    }
    persistNotificationsEnabled(false);
    this.notificationsEnabled = false;
    await unregisterPeriodicReminderSync();
    await this.syncReminders();
  }

  addTimeToNewMedication(): void {
    if (!this.newTime || this.newMedicationTimes.includes(this.newTime)) return;
    this.newMedicationTimes = [...this.newMedicationTimes, this.newTime].sort();
    this.newTime = '';
  }

  removeNewMedicationTime(time: string): void {
    this.newMedicationTimes = this.newMedicationTimes.filter((item) => item !== time);
  }

  createMedication(): void {
    const displayName = this.formatMedicationDisplayName(
      this.newMedicationName,
      this.newMedicationDose,
      this.newMedicationDoseUnit,
    );
    if (!displayName || this.newMedicationTimes.length === 0) return;

    const stockCount = this.parseStockInput(this.newMedicationStock);

    const next: Medication[] = [
      ...this.medications,
      {
        id: uid(),
        name: displayName,
        times: [...this.newMedicationTimes].sort(),
        stockCount,
      },
    ].sort((a, b) => a.name.localeCompare(b.name));

    this.saveMedications(next);
    this.newMedicationName = '';
    this.newMedicationDose = '';
    this.newMedicationDoseUnit = 'mg';
    this.newMedicationStock = '';
    this.newMedicationTimes = [];
  }

  private formatMedicationDisplayName(name: string, dose: string, unit: DoseUnit): string {
    const trimmedName = name.trim();
    const trimmedDose = dose.trim();
    if (!trimmedName) return '';
    if (!trimmedDose) return trimmedName;

    const parsedDose = Number(trimmedDose);
    const doseLabel = Number.isFinite(parsedDose) ? String(parsedDose) : trimmedDose;
    return `${trimmedName} ${doseLabel} ${unit}`;
  }

  deleteMedication(medicationId: string): void {
    const next = this.medications.filter((med) => med.id !== medicationId);
    this.saveMedications(next);
    if (this.renamingMedicationId === medicationId) {
      this.cancelRenameMedication();
    }
  }

  startRenameMedication(medication: Medication): void {
    this.renamingMedicationId = medication.id;
    this.renameDraft = medication.name;
  }

  cancelRenameMedication(): void {
    this.renamingMedicationId = null;
    this.renameDraft = '';
  }

  saveRenameMedication(medicationId: string): void {
    const trimmed = this.renameDraft.trim();
    if (!trimmed) return;
    const next = this.medications
      .map((m) => (m.id === medicationId ? { ...m, name: trimmed } : m))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.saveMedications(next);

    const updatedLogs = this.logs.map((entry) =>
      entry.medicationId === medicationId ? { ...entry, medicationName: trimmed } : entry,
    );
    this.saveLogs(updatedLogs);
    this.cancelRenameMedication();
  }

  updateMedicationTimes(medicationId: string, nextTimes: string[]): void {
    const next = this.medications.map((medication) =>
      medication.id === medicationId
        ? { ...medication, times: [...new Set(nextTimes)].sort() }
        : medication,
    );
    this.saveMedications(next);
  }

  updateMedicationStock(medicationId: string, rawValue: string | number | null | undefined): void {
    const stockCount = this.parseStockInput(rawValue);
    const next = this.medications.map((medication) =>
      medication.id === medicationId ? { ...medication, stockCount } : medication,
    );
    this.saveMedications(next);
  }

  addStockToNew(amount: number): void {
    const current = Number(this.newMedicationStock) || 0;
    this.newMedicationStock = String(current + amount);
  }

  addStockToExisting(medication: any, amount: number): void {
    const current = medication.stockCount === null ? 0 : medication.stockCount;
    this.updateMedicationStock(medication.id, current + amount);
  }

  private parseStockInput(rawValue: string | number | null | undefined): number | null {
    if (rawValue === null || rawValue === undefined || rawValue === '') return null;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.floor(parsed);
  }

  private inventoryDeltaForStatusChange(previous: Status | undefined, next: Status): number {
    if (previous === next) return 0;
    if (next === 'taken' && previous !== 'taken') return -1;
    if (previous === 'taken' && next === 'skipped') return 1;
    return 0;
  }

  private applyMedicationStockDelta(medicationId: string, delta: number): void {
    if (delta === 0) return;
    const target = this.medications.find((medication) => medication.id === medicationId);
    if (!target || target.stockCount === null) return;

    const next = this.medications.map((medication) => {
      if (medication.id !== medicationId || medication.stockCount === null) return medication;
      return {
        ...medication,
        stockCount: Math.max(0, medication.stockCount + delta),
      };
    });
    this.saveMedications(next);
  }

  addTimeToMedication(medicationId: string): void {
    const candidate = this.newTimeByMedication[medicationId];
    if (!candidate) return;
    const medication = this.medications.find((med) => med.id === medicationId);
    if (!medication || medication.times.includes(candidate)) return;
    this.updateMedicationTimes(medicationId, [...medication.times, candidate]);
    this.newTimeByMedication = { ...this.newTimeByMedication, [medicationId]: '' };
  }

  onMedicationTimeChange(medication: Medication, originalTime: string, nextTime: string): void {
    const next = medication.times.map((item) => (item === originalTime ? nextTime : item));
    this.updateMedicationTimes(medication.id, next);
  }

  removeMedicationTime(medication: Medication, time: string): void {
    this.updateMedicationTimes(
      medication.id,
      medication.times.filter((item) => item !== time),
    );
  }

  setNewTimeForMedication(medicationId: string, value: string): void {
    this.newTimeByMedication = { ...this.newTimeByMedication, [medicationId]: value };
  }

  toPickerValue(time: string | undefined): string | undefined {
    if (!time) return undefined;
    return `1970-01-01T${time}:00`;
  }

  private extractTimeFromPicker(value: string | string[] | null | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw || typeof raw !== 'string') return null;
    if (/^\d{2}:\d{2}$/.test(raw)) return raw;
    const match = raw.match(/T(\d{2}:\d{2})/);
    return match ? match[1] : null;
  }

  onNewTimePicked(
    event: CustomEvent<{ value?: string | string[] | null }>,
    modal?: { dismiss: () => Promise<boolean> },
  ): void {
    const picked = this.extractTimeFromPicker(event.detail.value);
    if (!picked) return;
    this.newTime = picked;
    this.closePicker(modal);
  }

  onMedicationTimePicked(
    medication: Medication,
    originalTime: string,
    event: CustomEvent<{ value?: string | string[] | null }>,
    modal?: { dismiss: () => Promise<boolean> },
  ): void {
    const picked = this.extractTimeFromPicker(event.detail.value);
    if (!picked) return;
    this.onMedicationTimeChange(medication, originalTime, picked);
    this.closePicker(modal);
  }

  onAdditionalTimePicked(
    medicationId: string,
    event: CustomEvent<{ value?: string | string[] | null }>,
    modal?: { dismiss: () => Promise<boolean> },
  ): void {
    const picked = this.extractTimeFromPicker(event.detail.value);
    if (!picked) return;
    this.setNewTimeForMedication(medicationId, picked);
    this.closePicker(modal);
  }

  editTimePickerId(medicationId: string, time: string): string {
    return `edit-${medicationId}-${time.replace(':', '-')}`;
  }

  addTimePickerId(medicationId: string): string {
    return `add-${medicationId}`;
  }

  private closePicker(modal: { dismiss: () => Promise<boolean> } | null | undefined): void {
    if (!modal) return;
    void modal.dismiss();
  }

  setScheduleStatus(
    medicationId: string,
    medicationName: string,
    dateKey: string,
    time: string,
    status: Status,
  ): void {
    const existing = this.logs.find(
      (item) => item.medicationId === medicationId && item.dateKey === dateKey && item.time === time,
    );
    const stockDelta = this.inventoryDeltaForStatusChange(existing?.status, status);
    const nextEntry: LogEntry = {
      id: existing?.id ?? uid(),
      medicationId,
      medicationName,
      dateKey,
      time,
      status,
      updatedAt: new Date().toISOString(),
    };
    const next = existing
      ? this.logs.map((item) => (item.id === existing.id ? nextEntry : item))
      : [...this.logs, nextEntry];
    this.applyMedicationStockDelta(medicationId, stockDelta);
    this.saveLogs(next);
  }

  triggerImportBackup(): void {
    this.importInputRef?.nativeElement.click();
  }

  handleExportBackup(): void {
    if (this.instant.useCloud) {
      return;
    }
    const reminderBeeps = parseJson<Record<string, { first?: boolean; second?: boolean }>>(
      localStorage.getItem(REMINDER_FLAGS_KEY),
      {},
    );
    const json = buildMedtrackerBackupJson({
      medications: this.medications,
      logs: this.logs,
      reminderBeeps,
      notificationsEnabled: this.notificationsEnabled,
    });
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `medtracker-backup-${todayKey()}.json`;
    a.rel = 'noopener';
    a.click();
    URL.revokeObjectURL(url);
  }

  async handleImportBackupFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    const text = await file.text();
    const result = parseMedtrackerBackupJson(text);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }

    if (
      !window.confirm(
        'Alle huidige medicijnen en het logboek worden vervangen door dit bestand. Doorgaan?',
      )
    ) {
      return;
    }

    const { data } = result;
    const importedLogs = pruneHistoryLogs(data.logs);
    const nextMedications = data.medications.map(normalizeMedication);

    try {
      if (this.instant.useCloud) {
        await this.instant.replaceAllFromBackup(nextMedications, importedLogs);
      } else {
        localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(nextMedications));
        localStorage.setItem(LOGS_KEY, JSON.stringify(importedLogs));
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Importeren naar opslag is mislukt.');
      return;
    }

    localStorage.setItem(REMINDER_FLAGS_KEY, JSON.stringify(data.reminderBeeps ?? {}));
    persistNotificationsEnabled(data.notificationsEnabled ?? false);

    this.medications = nextMedications;
    this.logs = importedLogs;
    this.flags = data.reminderBeeps ?? {};
    this.notificationsEnabled = data.notificationsEnabled ?? false;

    this.cancelRenameMedication();
    this.newMedicationName = '';
    this.newMedicationDose = '';
    this.newMedicationDoseUnit = 'mg';
    this.newTime = '';
    this.newMedicationStock = '';
    this.newMedicationTimes = [];
    this.newTimeByMedication = {};
    this.lowStockAlerts = parseJson<Record<string, boolean>>(localStorage.getItem(LOW_STOCK_ALERTS_KEY), {});
    this.reconcilePeriodicSync();
    await this.syncReminders();
    await this.notifyLowStockIfNeeded();
    this.cdr.markForCheck();
  }

  readonly todayKey = todayKey;

  async sendLoginCode(): Promise<void> {
    this.loginHint = null;
    this.instantError = null;
    this.loginBusy = true;
    try {
      await this.instant.sendLoginCode(this.loginEmail);
      this.codeSent = true;
      this.loginHint = 'Code verstuurd. Controleer je inbox (ook spam).';
    } catch (e) {
      this.loginHint = e instanceof Error ? e.message : 'Code versturen mislukt.';
    } finally {
      this.loginBusy = false;
      this.cdr.markForCheck();
    }
  }

  async submitLoginCode(): Promise<void> {
    this.loginHint = null;
    this.instantError = null;
    this.loginBusy = true;
    this.instantLoading = true;
    try {
      await this.instant.signInWithEmailCode(this.loginEmail, this.loginCode);
      this.loginCode = '';
      this.codeSent = false;
      this.loginHint = null;
    } catch (e) {
      this.loginHint = e instanceof Error ? e.message : 'Inloggen mislukt.';
      this.instantLoading = false;
    } finally {
      this.loginBusy = false;
      this.cdr.markForCheck();
    }
  }

  async continueAsGuestDevice(): Promise<void> {
    this.loginHint = null;
    this.instantError = null;
    this.loginBusy = true;
    this.instantLoading = true;
    try {
      await this.instant.signInAsGuestDevice();
    } catch (e) {
      this.loginHint = e instanceof Error ? e.message : 'Anoniem inloggen mislukt.';
      this.instantLoading = false;
    } finally {
      this.loginBusy = false;
      this.cdr.markForCheck();
    }
  }

  async signOutCloud(): Promise<void> {
    this.loginEmail = '';
    this.loginCode = '';
    this.codeSent = false;
    this.loginHint = null;
    this.instantError = null;
    await this.instant.signOutCloud();
    this.medications = [];
    this.logs = [];
    this.flags = {};
    this.instantLoading = false;
    this.cancelRenameMedication();
    this.cdr.markForCheck();
  }

}
