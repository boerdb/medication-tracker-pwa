import type { LogLite, MedicationLite } from './reminderLogic'
import { getNotificationsEnabled } from './notificationPrefs'

export const REMINDER_FLAGS_KEY = 'medtracker:reminderBeeps'
export const MEDICATIONS_KEY = 'medtracker:medications'
export const LOGS_KEY = 'medtracker:logs'

export const CACHE_DATA_NAME = 'medtracker-data-v1'
/** Stable URL used by the app and service worker for the shared reminder snapshot */
export const BUNDLE_PATH = '/medtracker-sw-bundle.json'

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export type ReminderBundle = {
  medications: MedicationLite[]
  logs: LogLite[]
  reminderBeeps: Record<string, { first?: boolean; second?: boolean }>
  notificationsEnabled: boolean
  storedAt: number
}

export async function syncReminderBundleToCache(): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return
  try {
    const bundle: ReminderBundle = {
      medications: parseJson<MedicationLite[]>(localStorage.getItem(MEDICATIONS_KEY), []),
      logs: parseJson<LogLite[]>(localStorage.getItem(LOGS_KEY), []),
      reminderBeeps: parseJson(localStorage.getItem(REMINDER_FLAGS_KEY), {}),
      notificationsEnabled: getNotificationsEnabled(),
      storedAt: Date.now(),
    }
    const cache = await caches.open(CACHE_DATA_NAME)
    const url = `${window.location.origin}${BUNDLE_PATH}`
    await cache.put(new Request(url), new Response(JSON.stringify(bundle)))
  } catch {
    // ignore quota / private mode
  }
}

export async function mergeReminderFlagsFromCache(): Promise<
  Record<string, { first?: boolean; second?: boolean }> | null
> {
  if (typeof window === 'undefined' || !('caches' in window)) return null
  try {
    const cache = await caches.open(CACHE_DATA_NAME)
    const url = `${window.location.origin}${BUNDLE_PATH}`
    const res = await cache.match(url)
    if (!res) return null
    const bundle = (await res.json()) as ReminderBundle
    return bundle.reminderBeeps ?? null
  } catch {
    return null
  }
}

export function mergeReminderFlagRecords(
  local: Record<string, { first?: boolean; second?: boolean }>,
  remote: Record<string, { first?: boolean; second?: boolean }> | null,
): Record<string, { first?: boolean; second?: boolean }> {
  if (!remote) return local
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)])
  const out: Record<string, { first?: boolean; second?: boolean }> = {}
  for (const k of keys) {
    const a = local[k]
    const b = remote[k]
    out[k] = {
      first: Boolean(a?.first || b?.first),
      second: Boolean(a?.second || b?.second),
    }
  }
  return out
}

/** Chrome/Edge: periodic background checks (best-effort; interval depends on browser/OS). */
export async function registerPeriodicReminderSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready
    const periodicSync = (
      reg as ServiceWorkerRegistration & {
        periodicSync?: { register: (tag: string, opts: { minInterval: number }) => Promise<void> }
      }
    ).periodicSync
    if (periodicSync?.register) {
      await periodicSync.register('medtracker-reminders', { minInterval: 60 * 1000 })
    }
  } catch {
    // unsupported or denied
  }
}

export async function unregisterPeriodicReminderSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready
    const periodicSync = (
      reg as ServiceWorkerRegistration & {
        periodicSync?: { getTags: () => Promise<string[]>; unregister: (tag: string) => Promise<void> }
      }
    ).periodicSync
    if (periodicSync?.getTags && periodicSync.unregister) {
      const tags = await periodicSync.getTags()
      if (tags.includes('medtracker-reminders')) {
        await periodicSync.unregister('medtracker-reminders')
      }
    }
  } catch {
    // ignore
  }
}
