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

function validateMedication(x: unknown): x is ExportedMedication {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || typeof o['name'] !== 'string') return false;
  if (!Array.isArray(o['times'])) return false;
  if (!o['times'].every((t) => typeof t === 'string')) return false;

  const stockCount = o['stockCount'];
  if (stockCount === undefined || stockCount === null) return true;
  return typeof stockCount === 'number' && Number.isFinite(stockCount) && stockCount >= 0;
}

function validateLogEntry(x: unknown): x is ExportedLogEntry {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  const statusOk = o['status'] === 'taken' || o['status'] === 'skipped';
  return (
    statusOk &&
    typeof o['id'] === 'string' &&
    typeof o['medicationId'] === 'string' &&
    typeof o['medicationName'] === 'string' &&
    typeof o['dateKey'] === 'string' &&
    typeof o['time'] === 'string' &&
    typeof o['updatedAt'] === 'string'
  );
}

export function parseMedtrackerBackupJson(
  raw: string,
): { ok: true; data: MedtrackerBackupV1 } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
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

  if (!Array.isArray(obj['medications']) || !Array.isArray(obj['logs'])) {
    return { ok: false, error: 'Het bestand mist medications of logs.' };
  }

  if (!obj['medications'].every(validateMedication)) {
    return { ok: false, error: 'Ongeldige medicatiegegevens in het bestand.' };
  }

  if (!obj['logs'].every(validateLogEntry)) {
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
    medications: obj['medications'],
    logs: obj['logs'],
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
