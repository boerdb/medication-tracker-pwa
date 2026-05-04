import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
} from 'react'
import './App.css'
import {
  getNotificationsEnabled,
  persistNotificationsEnabled,
  requestNotificationPermission,
} from './notificationPrefs'
import { buildMedtrackerBackupJson, parseMedtrackerBackupJson } from './backup'
import {
  MEDICATIONS_KEY,
  LOGS_KEY,
  REMINDER_FLAGS_KEY,
  registerPeriodicReminderSync,
  syncReminderBundleToCache,
  unregisterPeriodicReminderSync,
} from './reminderSync'
import { useMedicationReminders } from './medicationReminders'
import { PwaPrompts } from './PwaPrompts'

type Tab = 'today' | 'manage' | 'history'
type Status = 'taken' | 'skipped'

type Medication = {
  id: string
  name: string
  times: string[]
}

type LogEntry = {
  id: string
  medicationId: string
  medicationName: string
  dateKey: string
  time: string
  status: Status
  updatedAt: string
}

const formatTodayLabel = () =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date())

const todayKey = () => new Date().toISOString().split('T')[0]

const parseJson = <T,>(value: string | null, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

/** Wraps native time input with a visible clock icon (iOS often hides the built-in affordance). */
function TimeField({ className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <div className="time-field">
      <input {...rest} type="time" className={['time-field__input', className].filter(Boolean).join(' ')} />
      <span className="time-field__icon" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </span>
    </div>
  )
}

function App() {
  const [tab, setTab] = useState<Tab>('today')
  const [medications, setMedications] = useState<Medication[]>(() =>
    parseJson<Medication[]>(localStorage.getItem(MEDICATIONS_KEY), []),
  )
  const [logs, setLogs] = useState<LogEntry[]>(() =>
    parseJson<LogEntry[]>(localStorage.getItem(LOGS_KEY), []),
  )
  const [newMedicationName, setNewMedicationName] = useState('')
  const [newTime, setNewTime] = useState('')
  const [newMedicationTimes, setNewMedicationTimes] = useState<string[]>([])
  const [newTimeByMedication, setNewTimeByMedication] = useState<
    Record<string, string>
  >({})
  const [renamingMedicationId, setRenamingMedicationId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [notificationsEnabled, setNotificationsEnabledState] = useState(() =>
    getNotificationsEnabled(),
  )

  const importBackupInputRef = useRef<HTMLInputElement>(null)

  useMedicationReminders(medications, logs, notificationsEnabled)

  useEffect(() => {
    void syncReminderBundleToCache()
  }, [medications, logs, notificationsEnabled])

  useEffect(() => {
    if (
      notificationsEnabled &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      void registerPeriodicReminderSync()
    } else {
      void unregisterPeriodicReminderSync()
    }
  }, [notificationsEnabled])

  const notificationPermission: NotificationPermission | 'unsupported' =
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission

  const handleNotificationsToggle = async (checked: boolean) => {
    if (checked) {
      const p = await requestNotificationPermission()
      if (p !== 'granted') return
      persistNotificationsEnabled(true)
      setNotificationsEnabledState(true)
      await registerPeriodicReminderSync()
      await syncReminderBundleToCache()
      return
    }
    persistNotificationsEnabled(false)
    setNotificationsEnabledState(false)
    await unregisterPeriodicReminderSync()
    await syncReminderBundleToCache()
  }

  const saveMedications = (next: Medication[]) => {
    setMedications(next)
    localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(next))
  }

  const saveLogs = (next: LogEntry[]) => {
    setLogs(next)
    localStorage.setItem(LOGS_KEY, JSON.stringify(next))
  }

  const addTimeToNewMedication = () => {
    if (!newTime || newMedicationTimes.includes(newTime)) return
    setNewMedicationTimes((prev) => [...prev, newTime].sort())
    setNewTime('')
  }

  const createMedication = () => {
    const trimmedName = newMedicationName.trim()
    if (!trimmedName || newMedicationTimes.length === 0) return

    const next: Medication[] = [
      ...medications,
      { id: uid(), name: trimmedName, times: [...newMedicationTimes].sort() },
    ].sort((a, b) => a.name.localeCompare(b.name))

    saveMedications(next)
    setNewMedicationName('')
    setNewMedicationTimes([])
  }

  const deleteMedication = (medicationId: string) => {
    const next = medications.filter((med) => med.id !== medicationId)
    saveMedications(next)
    if (renamingMedicationId === medicationId) {
      setRenamingMedicationId(null)
      setRenameDraft('')
    }
  }

  const startRenameMedication = (medication: Medication) => {
    setRenamingMedicationId(medication.id)
    setRenameDraft(medication.name)
  }

  const cancelRenameMedication = () => {
    setRenamingMedicationId(null)
    setRenameDraft('')
  }

  const saveRenameMedication = (medicationId: string) => {
    const trimmed = renameDraft.trim()
    if (!trimmed) return
    const next = medications
      .map((m) => (m.id === medicationId ? { ...m, name: trimmed } : m))
      .sort((a, b) => a.name.localeCompare(b.name))
    saveMedications(next)
    const updatedLogs = logs.map((entry) =>
      entry.medicationId === medicationId ? { ...entry, medicationName: trimmed } : entry,
    )
    saveLogs(updatedLogs)
    cancelRenameMedication()
  }

  const handleExportBackup = () => {
    const reminderBeeps = parseJson<Record<string, { first?: boolean; second?: boolean }>>(
      localStorage.getItem(REMINDER_FLAGS_KEY),
      {},
    )
    const json = buildMedtrackerBackupJson({
      medications,
      logs,
      reminderBeeps,
      notificationsEnabled,
    })
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `medtracker-backup-${todayKey()}.json`
    a.rel = 'noopener'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportBackupFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const text = await file.text()
    const result = parseMedtrackerBackupJson(text)
    if (!result.ok) {
      window.alert(result.error)
      return
    }
    if (
      !window.confirm(
        'Alle huidige medicijnen en het logboek worden vervangen door dit bestand. Doorgaan?',
      )
    ) {
      return
    }
    const { data } = result
    localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(data.medications))
    localStorage.setItem(LOGS_KEY, JSON.stringify(data.logs))
    localStorage.setItem(REMINDER_FLAGS_KEY, JSON.stringify(data.reminderBeeps ?? {}))
    persistNotificationsEnabled(data.notificationsEnabled ?? false)
    setMedications(data.medications)
    setLogs(data.logs)
    setNotificationsEnabledState(data.notificationsEnabled ?? false)
    cancelRenameMedication()
    setNewMedicationName('')
    setNewTime('')
    setNewMedicationTimes([])
    setNewTimeByMedication({})
    void syncReminderBundleToCache()
  }

  const updateMedicationTimes = (medicationId: string, nextTimes: string[]) => {
    const next = medications.map((medication) =>
      medication.id === medicationId
        ? { ...medication, times: [...new Set(nextTimes)].sort() }
        : medication,
    )
    saveMedications(next)
  }

  const addTimeToMedication = (medicationId: string) => {
    const candidate = newTimeByMedication[medicationId]
    if (!candidate) return
    const medication = medications.find((med) => med.id === medicationId)
    if (!medication || medication.times.includes(candidate)) return
    updateMedicationTimes(medicationId, [...medication.times, candidate])
    setNewTimeByMedication((prev) => ({ ...prev, [medicationId]: '' }))
  }

  const setScheduleStatus = (
    medicationId: string,
    medicationName: string,
    dateKey: string,
    time: string,
    status: Status,
  ) => {
    const existing = logs.find(
      (item) =>
        item.medicationId === medicationId &&
        item.dateKey === dateKey &&
        item.time === time,
    )
    const nextEntry: LogEntry = {
      id: existing?.id ?? uid(),
      medicationId,
      medicationName,
      dateKey,
      time,
      status,
      updatedAt: new Date().toISOString(),
    }
    const next = existing
      ? logs.map((item) => (item.id === existing.id ? nextEntry : item))
      : [...logs, nextEntry]
    saveLogs(next)
  }

  const todaySchedules = useMemo(() => {
    const key = todayKey()
    const statusBySlot = new Map(
      logs
        .filter((item) => item.dateKey === key)
        .map((item) => [`${item.medicationId}::${item.time}`, item.status]),
    )

    return medications
      .flatMap((medication) =>
        medication.times.map((time) => ({
          id: `${medication.id}-${time}`,
          medicationId: medication.id,
          medicationName: medication.name,
          time,
          status: statusBySlot.get(`${medication.id}::${time}`),
        })),
      )
      .sort((a, b) => a.time.localeCompare(b.time))
  }, [logs, medications])

  const historyRows = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)

    return logs
      .filter((item) => new Date(item.updatedAt) >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }, [logs])

  const historySummary = useMemo(() => {
    const taken = historyRows.filter((item) => item.status === 'taken').length
    const skipped = historyRows.filter((item) => item.status === 'skipped').length
    return { taken, skipped }
  }, [historyRows])

  return (
    <div className="app-shell">
      <PwaPrompts />
      <header className="app-header">
        <div>
          <p className="eyebrow">Medication Tracker</p>
          <h1>Daily Medication Companion</h1>
          <p className="subtitle">{formatTodayLabel()}</p>
        </div>
      </header>

      <nav className="tabs" aria-label="Medication tracker sections">
        {([
          ['today', 'Today'],
          ['manage', 'Manage Medication'],
          ['history', 'History'],
        ] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`tab-button ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'today' && (
        <section className="panel">
          <h2>Today</h2>
          <p className="section-copy">
            Track every scheduled intake with one tap.
          </p>
          <div className="notification-card" role="region" aria-label="Reminder notifications">
            <label className="notification-toggle">
              <input
                type="checkbox"
                checked={notificationsEnabled}
                onChange={(event) => void handleNotificationsToggle(event.target.checked)}
                disabled={notificationPermission === 'unsupported'}
              />
              <span>
                Browser notifications for missed doses (works best when the site is installed or
                pinned; background timing depends on your browser).
              </span>
            </label>
            {notificationPermission === 'denied' && (
              <p className="notification-hint">
                Notifications are blocked for this site. Enable them in your browser settings to use
                reminders when the app is closed.
              </p>
            )}
            {notificationPermission === 'unsupported' && (
              <p className="notification-hint">This browser does not support notifications.</p>
            )}
          </div>
          <div className="card-list">
            {todaySchedules.length === 0 ? (
              <p className="empty-state">
                No medication scheduled yet. Add entries in Manage Medication.
              </p>
            ) : (
              todaySchedules.map((item) => (
                <article className="dose-card" key={item.id}>
                  <div>
                    <p className="dose-title">{item.medicationName}</p>
                    <p className="dose-time">{item.time}</p>
                  </div>
                  <div className="dose-actions">
                    <button
                      type="button"
                      className={`status-button take ${
                        item.status === 'taken' ? 'selected' : ''
                      }`}
                      onClick={() =>
                        setScheduleStatus(
                          item.medicationId,
                          item.medicationName,
                          todayKey(),
                          item.time,
                          'taken',
                        )
                      }
                    >
                      Take
                    </button>
                    <button
                      type="button"
                      className={`status-button skip ${
                        item.status === 'skipped' ? 'selected' : ''
                      }`}
                      onClick={() =>
                        setScheduleStatus(
                          item.medicationId,
                          item.medicationName,
                          todayKey(),
                          item.time,
                          'skipped',
                        )
                      }
                    >
                      Skip
                    </button>
                    <span
                      className={`status-pill ${
                        item.status ? `status-${item.status}` : ''
                      }`}
                    >
                      {item.status ? item.status.toUpperCase() : 'PENDING'}
                    </span>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      )}

      {tab === 'manage' && (
        <section className="panel">
          <h2>Manage Medication</h2>
          <p className="section-copy">Add, edit, and delete medication plans.</p>

          <div className="manage-card">
            <h3>Add Medication</h3>
            <div className="input-row">
              <input
                type="text"
                placeholder="Medication name"
                value={newMedicationName}
                onChange={(event) => setNewMedicationName(event.target.value)}
              />
              <TimeField
                aria-label="New medication time"
                value={newTime}
                onChange={(event) => setNewTime(event.target.value)}
              />
              <button type="button" onClick={addTimeToNewMedication}>
                Add Time
              </button>
              <button type="button" className="primary" onClick={createMedication}>
                Save
              </button>
            </div>
            <div className="time-chip-wrap">
              {newMedicationTimes.map((time) => (
                <button
                  key={time}
                  type="button"
                  className="time-chip"
                  onClick={() =>
                    setNewMedicationTimes((prev) => prev.filter((item) => item !== time))
                  }
                >
                  {time} x
                </button>
              ))}
            </div>
          </div>

          <div className="card-list">
            {medications.map((medication) => (
              <article className="manage-card" key={medication.id}>
                <div className="manage-header">
                  {renamingMedicationId === medication.id ? (
                    <>
                      <input
                        type="text"
                        className="medication-name-field"
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') saveRenameMedication(medication.id)
                          if (event.key === 'Escape') cancelRenameMedication()
                        }}
                        aria-label="Medication name"
                        autoFocus
                      />
                      <div className="manage-header-actions">
                        <button
                          type="button"
                          className="primary"
                          onClick={() => saveRenameMedication(medication.id)}
                        >
                          Save name
                        </button>
                        <button type="button" onClick={cancelRenameMedication}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3>{medication.name}</h3>
                      <div className="manage-header-actions">
                        <button type="button" onClick={() => startRenameMedication(medication)}>
                          Rename
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => deleteMedication(medication.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <div className="time-chip-wrap">
                  {medication.times.map((time) => (
                    <div className="editable-time" key={`${medication.id}-${time}`}>
                      <TimeField
                        aria-label={`Edit time for ${medication.name}`}
                        value={time}
                        onChange={(event) =>
                          updateMedicationTimes(
                            medication.id,
                            medication.times.map((item) =>
                              item === time ? event.target.value : item,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          updateMedicationTimes(
                            medication.id,
                            medication.times.filter((item) => item !== time),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <div className="input-row compact">
                  <TimeField
                    aria-label={`Add time to ${medication.name}`}
                    value={newTimeByMedication[medication.id] ?? ''}
                    onChange={(event) =>
                      setNewTimeByMedication((prev) => ({
                        ...prev,
                        [medication.id]: event.target.value,
                      }))
                    }
                  />
                  <button type="button" onClick={() => addTimeToMedication(medication.id)}>
                    Add Intake Time
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="manage-card backup-card">
            <h3>Backup en herstel</h3>
            <p className="section-copy backup-card__intro">
              Sla je gegevens op als JSON op je apparaat (bijv. vóór het wissen van
              websitegegevens) of herstel een eerdere export.
            </p>
            <div className="backup-card__actions">
              <button type="button" className="primary" onClick={handleExportBackup}>
                Exporteren (JSON)
              </button>
              <button
                type="button"
                onClick={() => importBackupInputRef.current?.click()}
              >
                Importeren…
              </button>
              <input
                ref={importBackupInputRef}
                type="file"
                accept="application/json,.json"
                className="backup-file-input"
                aria-label="Kies een MedTracker JSON-backupbestand"
                onChange={handleImportBackupFile}
              />
            </div>
          </div>
        </section>
      )}

      {tab === 'history' && (
        <section className="panel">
          <h2>History</h2>
          <p className="section-copy">Last 30 days of taken versus skipped doses.</p>

          <div className="summary-grid">
            <div className="summary-card">
              <p className="summary-label">Taken</p>
              <p className="summary-value">{historySummary.taken}</p>
            </div>
            <div className="summary-card">
              <p className="summary-label">Skipped</p>
              <p className="summary-value">{historySummary.skipped}</p>
            </div>
            <div className="summary-card">
              <p className="summary-label">Total Logged</p>
              <p className="summary-value">{historyRows.length}</p>
            </div>
          </div>

          <div className="history-list">
            {historyRows.length === 0 ? (
              <p className="empty-state">No entries logged in the last 30 days.</p>
            ) : (
              historyRows.map((entry) => (
                <article key={entry.id} className="history-item">
                  <div>
                    <p className="dose-title">{entry.medicationName}</p>
                    <p className="history-meta">
                      {entry.dateKey} at {entry.time}
                    </p>
                  </div>
                  <span className={`status-pill status-${entry.status}`}>
                    {entry.status.toUpperCase()}
                  </span>
                </article>
              ))
            )}
          </div>
        </section>
      )}
    </div>
  )
}

export default App
