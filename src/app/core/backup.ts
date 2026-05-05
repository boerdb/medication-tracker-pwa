export type ExportedMedication = {
  id: string;
  name: string;
  times: string[];
  stockCount?: number | null;
};

export type ExportedLogEntry = {
  id: string;
  medicationId: string;
  medicationName: string;
  dateKey: string;
  time: string;
  status: 'taken' | 'skipped';
  updatedAt: string;
};

export type MedtrackerBackupV1 = {
  schemaVersion: 1;
  exportedAt: string;
  medications: ExportedMedication[];
  logs: ExportedLogEntry[];
  reminderBeeps?: Record<string, { first?: boolean; second?: boolean }>;
  notificationsEnabled?: boolean;
};

function validateMedicationShape(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || typeof o['name'] !== 'string') return false;
  if (!Array.isArray(o['times'])) return false;
  if (!o['times'].every((t) => typeof t === 'string')) return false;

  const stockCount = o['stockCount'];
  if (stockCount === undefined || stockCount === null) return true;
  if (typeof stockCount === 'number') {
    return Number.isFinite(stockCount) && stockCount >= 0;
  }
  if (typeof stockCount === 'string') {
    const n = Number(stockCount.trim());
    return Number.isFinite(n) && n >= 0;
  }
  return false;
}

function validateLogEntryShape(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  const statusOk = o['status'] === 'taken' || o['status'] === 'skipped';
  const updatedOk =
    typeof o['updatedAt'] === 'string' ||
    (typeof o['updatedAt'] === 'number' && Number.isFinite(o['updatedAt']));
  return (
    statusOk &&
    updatedOk &&
    typeof o['id'] === 'string' &&
    typeof o['medicationId'] === 'string' &&
    typeof o['medicationName'] === 'string' &&
    typeof o['dateKey'] === 'string' &&
    typeof o['time'] === 'string'
  );
}

function normalizeExportedMedication(raw: unknown): ExportedMedication {
  const o = raw as Record<string, unknown>;
  const sc = o['stockCount'];
  let stockCount: number | null | undefined;
  if (sc === undefined) {
    stockCount = undefined;
  } else if (sc === null) {
    stockCount = null;
  } else if (typeof sc === 'number' && Number.isFinite(sc) && sc >= 0) {
    stockCount = Math.floor(sc);
  } else if (typeof sc === 'string') {
    const n = Number(sc.trim());
    stockCount = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  } else {
    stockCount = null;
  }
  const base: ExportedMedication = {
    id: o['id'] as string,
    name: o['name'] as string,
    times: o['times'] as string[],
  };
  if (stockCount !== undefined) {
    return { ...base, stockCount };
  }
  return base;
}

function normalizeExportedLogEntry(raw: unknown): ExportedLogEntry {
  const o = raw as Record<string, unknown>;
  const u = o['updatedAt'];
  const updatedAt =
    typeof u === 'string'
      ? u
      : typeof u === 'number' && Number.isFinite(u)
        ? new Date(u).toISOString()
        : new Date().toISOString();
  return {
    id: o['id'] as string,
    medicationId: o['medicationId'] as string,
    medicationName: o['medicationName'] as string,
    dateKey: o['dateKey'] as string,
    time: o['time'] as string,
    status: o['status'] as 'taken' | 'skipped',
    updatedAt,
  };
}

function stripBom(s: string): string {
  return s.replace(/^\uFEFF/, '');
}

export function parseMedtrackerBackupJson(
  raw: string,
): { ok: true; data: MedtrackerBackupV1 } | { ok: false; error: string } {
  const text = stripBom(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: 'Geen geldige JSON.' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Bestand is leeg of ongeldig.' };
  }

  const obj = parsed as Record<string, unknown>;
  const sv = obj['schemaVersion'];
  if (sv !== undefined && sv !== 1) {
    return { ok: false, error: `Exportversie ${String(sv)} wordt niet ondersteund (alleen versie 1).` };
  }

  if (!Array.isArray(obj['medications'])) {
    return { ok: false, error: 'Het bestand mist het veld medications (array).' };
  }

  const rawLogs = obj['logs'];
  const logsArray = Array.isArray(rawLogs) ? rawLogs : rawLogs === undefined ? [] : null;
  if (logsArray === null) {
    return { ok: false, error: 'Het veld logs is ongeldig (verwacht een array of weglating).' };
  }

  if (!obj['medications'].every(validateMedicationShape)) {
    return { ok: false, error: 'Ongeldige medicatiegegevens in het bestand.' };
  }

  if (!logsArray.every(validateLogEntryShape)) {
    return { ok: false, error: 'Ongeldige logboekgegevens in het bestand.' };
  }

  const reminderBeeps = obj['reminderBeeps'];
  if (reminderBeeps !== undefined) {
    if (typeof reminderBeeps !== 'object' || reminderBeeps === null || Array.isArray(reminderBeeps)) {
      return { ok: false, error: 'Ongeldig veld reminderBeeps.' };
    }
  }

  const notificationsEnabled =
    typeof obj['notificationsEnabled'] === 'boolean' ? obj['notificationsEnabled'] : undefined;

  const data: MedtrackerBackupV1 = {
    schemaVersion: 1,
    exportedAt: typeof obj['exportedAt'] === 'string' ? obj['exportedAt'] : new Date().toISOString(),
    medications: (obj['medications'] as unknown[]).map(normalizeExportedMedication),
    logs: logsArray.map(normalizeExportedLogEntry),
    reminderBeeps:
      reminderBeeps === undefined
        ? undefined
        : (reminderBeeps as Record<string, { first?: boolean; second?: boolean }>),
    notificationsEnabled,
  };

  return { ok: true, data };
}

export function buildMedtrackerBackupJson(params: {
  medications: ExportedMedication[];
  logs: ExportedLogEntry[];
  reminderBeeps: Record<string, { first?: boolean; second?: boolean }>;
  notificationsEnabled: boolean;
}): string {
  const payload: MedtrackerBackupV1 = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    medications: params.medications,
    logs: params.logs,
    reminderBeeps: params.reminderBeeps,
    notificationsEnabled: params.notificationsEnabled,
  };
  return JSON.stringify(payload, null, 2);
}
