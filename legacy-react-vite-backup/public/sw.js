const CACHE_NAME = 'medication-tracker-v7'
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
})

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'SKIP_WAITING') return
  const reply = () => {
    try {
      if (event.source && 'postMessage' in event.source) {
        event.source.postMessage({ type: 'SKIP_WAITING_APPLIED' })
      }
    } catch {
      /* ignore */
    }
  }
  try {
    const p = self.skipWaiting()
    if (p && typeof p.then === 'function') {
      p.then(reply).catch(reply)
    } else {
      reply()
    }
  } catch {
    reply()
  }
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)

  // Network-first for manifest so icon paths / metadata updates are not stuck behind stale cache.
  if (url.pathname.endsWith('/manifest.webmanifest')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return response
        })
        .catch(() => caches.match(event.request)),
    )
    return
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached
      return fetch(event.request)
        .then((response) => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response
          }
          const cloned = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned))
          return response
        })
        .catch(() => caches.match('/index.html'))
    }),
  )
})

function pruneOldDays(flags, keepDateKey) {
  const next = {}
  for (const key of Object.keys(flags)) {
    if (key.split('::')[0] === keepDateKey) next[key] = flags[key]
  }
  return next
}

function slotKey(dateKey, medicationId, time) {
  return `${dateKey}::${medicationId}::${time}`
}

function parseLocalScheduleMs(dateKey, timeHHMM) {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const [hh, mm] = timeHHMM.split(':').map(Number)
  return new Date(y, mo - 1, d, hh, mm, 0, 0).getTime()
}

function runReminderTick(now, dateKey, medications, logs, flags) {
  const nextFlags = { ...pruneOldDays(flags, dateKey) }
  const events = []
  const statusBySlot = new Map()
  for (const item of logs) {
    if (item.dateKey === dateKey) {
      statusBySlot.set(`${item.medicationId}::${item.time}`, item.status)
    }
  }
  for (const med of medications) {
    for (const time of med.times) {
      const status = statusBySlot.get(`${med.id}::${time}`)
      if (status === 'taken' || status === 'skipped') continue
      const sk = slotKey(dateKey, med.id, time)
      const dueMs = parseLocalScheduleMs(dateKey, time)
      const duePlus5 = dueMs + 5 * 60 * 1000
      const entry = nextFlags[sk] ?? {}
      if (now >= duePlus5 && !entry.second) {
        nextFlags[sk] = { ...entry, first: true, second: true }
        events.push({
          kind: 'second',
          medicationId: med.id,
          medicationName: med.name,
          time,
        })
        continue
      }
      if (now >= dueMs && now < duePlus5 && !entry.first) {
        nextFlags[sk] = { ...entry, first: true }
        events.push({
          kind: 'first',
          medicationId: med.id,
          medicationName: med.name,
          time,
        })
      }
    }
  }
  return { nextFlags, events }
}

async function periodicReminderCheck() {
  const CACHE_DATA_NAME = 'medtracker-data-v1'
  const BUNDLE_PATH = '/medtracker-sw-bundle.json'
  const cache = await caches.open(CACHE_DATA_NAME)
  const url = new URL(BUNDLE_PATH, self.location.origin).href
  const res = await cache.match(url)
  if (!res) return
  let bundle
  try {
    bundle = await res.json()
  } catch {
    return
  }
  if (!bundle.notificationsEnabled) return
  const now = Date.now()
  const dateKey = new Date().toISOString().split('T')[0]
  const { nextFlags, events } = runReminderTick(
    now,
    dateKey,
    bundle.medications || [],
    bundle.logs || [],
    bundle.reminderBeeps || {},
  )
  bundle.reminderBeeps = nextFlags
  bundle.storedAt = Date.now()
  await cache.put(new Request(url), new Response(JSON.stringify(bundle)))

  for (const ev of events) {
    const stage = ev.kind
    const title = stage === 'first' ? 'Medication due' : 'Medication still pending'
    const body =
      stage === 'first'
        ? `${ev.medicationName} — ${ev.time}. Open the app to log intake.`
        : `${ev.medicationName} at ${ev.time} — still not logged after 5 minutes.`
    const sk = slotKey(dateKey, ev.medicationId, ev.time)
    const tag = `mt-${sk.replace(/::/g, '-')}-${stage}`
    try {
      await self.registration.showNotification(title, {
        body,
        icon: '/icons/android-chrome-192x192.png',
        badge: '/icons/favicon-32x32.png',
        tag,
        renotify: true,
        vibrate: stage === 'first' ? [160] : [180, 100, 180],
      })
    } catch {
      // ignore
    }
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'medtracker-reminders') return
  event.waitUntil(periodicReminderCheck())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus()
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(new URL('/', self.location.origin).href)
      }
    }),
  )
})
