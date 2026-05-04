export const NOTIFICATIONS_ENABLED_KEY = 'medtracker:notificationsEnabled'

export function getNotificationsEnabled(): boolean {
  return localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) === '1'
}

export function persistNotificationsEnabled(value: boolean): void {
  localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, value ? '1' : '0')
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied'
  return Notification.requestPermission()
}

const slotTagForNotify = (slotKey: string) =>
  slotKey.replace(/::/g, '-').replace(/[^a-zA-Z0-9_-]/g, '')

/**
 * Prefer service worker notifications so they still work when the tab is in the background.
 */
export async function showMedicationNotification(
  medicationName: string,
  time: string,
  stage: 'first' | 'second',
  slotKey: string,
): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return

  const title = stage === 'first' ? 'Medication due' : 'Medication still pending'
  const body =
    stage === 'first'
      ? `${medicationName} — ${time}. Open the app to log intake.`
      : `${medicationName} at ${time} — still not logged after 5 minutes.`

  const tag = `mt-${slotTagForNotify(slotKey)}-${stage}`
  const icon = '/icons/android-chrome-192x192.png'
  const badge = '/icons/favicon-32x32.png'

  try {
    const reg = await navigator.serviceWorker?.ready
    if (reg) {
      await reg.showNotification(title, {
        body,
        icon,
        badge,
        tag,
        vibrate: stage === 'first' ? [160] : [180, 100, 180],
      } as NotificationOptions)
      return
    }
  } catch {
    // fall through
  }

  try {
    new Notification(title, { body, icon })
  } catch {
    // ignore
  }
}
