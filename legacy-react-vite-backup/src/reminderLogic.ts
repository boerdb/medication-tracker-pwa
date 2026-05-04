export type ReminderFlags = Record<string, { first?: boolean; second?: boolean }>

export type MedicationLite = { id: string; name: string; times: string[] }
export type LogLite = {
  medicationId: string
  dateKey: string
  time: string
  status: 'taken' | 'skipped'
}

export type ReminderEvent =
  | { kind: 'first'; medicationId: string; medicationName: string; time: string }
  | { kind: 'second'; medicationId: string; medicationName: string; time: string }

export function slotKey(dateKey: string, medicationId: string, time: string) {
  return `${dateKey}::${medicationId}::${time}`
}

export function parseLocalScheduleMs(dateKey: string, timeHHMM: string): number {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const [hh, mm] = timeHHMM.split(':').map(Number)
  return new Date(y, mo - 1, d, hh, mm, 0, 0).getTime()
}

export function pruneOldDays(flags: ReminderFlags, keepDateKey: string): ReminderFlags {
  const next: ReminderFlags = {}
  for (const [key, val] of Object.entries(flags)) {
    const datePrefix = key.split('::')[0]
    if (datePrefix === keepDateKey) next[key] = val
  }
  return next
}

/**
 * Pure reminder step: updates flags and returns optional first/second reminder events per dose.
 */
export function runReminderTick(params: {
  now: number
  dateKey: string
  medications: MedicationLite[]
  logs: LogLite[]
  flags: ReminderFlags
}): { nextFlags: ReminderFlags; events: ReminderEvent[] } {
  const { now, dateKey, medications, logs } = params
  let flags = { ...pruneOldDays(params.flags, dateKey) }
  const events: ReminderEvent[] = []

  const statusBySlot = new Map(
    logs
      .filter((item) => item.dateKey === dateKey)
      .map((item) => [`${item.medicationId}::${item.time}`, item.status]),
  )

  const medNameById = new Map(medications.map((m) => [m.id, m.name]))

  for (const med of medications) {
    for (const time of med.times) {
      const status = statusBySlot.get(`${med.id}::${time}`)
      if (status === 'taken' || status === 'skipped') continue

      const sk = slotKey(dateKey, med.id, time)
      const dueMs = parseLocalScheduleMs(dateKey, time)
      const duePlus5 = dueMs + 5 * 60 * 1000
      const entry = flags[sk] ?? {}

      if (now >= duePlus5 && !entry.second) {
        flags[sk] = { ...entry, first: true, second: true }
        events.push({
          kind: 'second',
          medicationId: med.id,
          medicationName: medNameById.get(med.id) ?? 'Medication',
          time,
        })
        continue
      }

      if (now >= dueMs && now < duePlus5 && !entry.first) {
        flags[sk] = { ...entry, first: true }
        events.push({
          kind: 'first',
          medicationId: med.id,
          medicationName: medNameById.get(med.id) ?? 'Medication',
          time,
        })
      }
    }
  }

  return { nextFlags: flags, events }
}
