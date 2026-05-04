import { useEffect, useRef } from 'react'
import { showMedicationNotification } from './notificationPrefs'
import {
  mergeReminderFlagRecords,
  mergeReminderFlagsFromCache,
  REMINDER_FLAGS_KEY,
  syncReminderBundleToCache,
} from './reminderSync'
import {
  runReminderTick,
  slotKey,
  type LogLite,
  type MedicationLite,
  type ReminderFlags,
} from './reminderLogic'

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const todayKey = () => new Date().toISOString().split('T')[0]

function loadFlags(): ReminderFlags {
  return parseJson<ReminderFlags>(localStorage.getItem(REMINDER_FLAGS_KEY), {})
}

function saveFlags(flags: ReminderFlags) {
  localStorage.setItem(REMINDER_FLAGS_KEY, JSON.stringify(flags))
}

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  return audioContext
}

async function playTone(durationMs = 130, frequency = 880, volume = 0.12): Promise<void> {
  const ctx = getAudioContext()
  try {
    if (ctx.state === 'suspended') await ctx.resume()
  } catch {
    return
  }

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.frequency.value = frequency
  osc.type = 'sine'
  const t0 = ctx.currentTime
  const dur = durationMs / 1000
  gain.gain.setValueAtTime(volume, t0)
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + dur)

  await new Promise((resolve) => setTimeout(resolve, durationMs))
}

async function playBeeps(count: number, gapMs = 220): Promise<void> {
  for (let i = 0; i < count; i++) {
    await playTone()
    if (i < count - 1) await new Promise((r) => setTimeout(r, gapMs))
  }
}

/**
 * Beeps + optional browser notifications (same schedule as flags).
 * Bundle sync lets the service worker run periodic checks when the tab is closed (best-effort).
 */
export function useMedicationReminders(
  medications: MedicationLite[],
  logs: LogLite[],
  notificationsEnabled: boolean,
): void {
  const flagsRef = useRef<ReminderFlags>(loadFlags())

  useEffect(() => {
    const handler = () => {
      void getAudioContext().resume().catch(() => {})
    }
    document.addEventListener('pointerdown', handler, { once: true })
    return () => document.removeEventListener('pointerdown', handler)
  }, [])

  useEffect(() => {
    const mergeRemoteFlags = async () => {
      const remote = await mergeReminderFlagsFromCache()
      if (!remote) return
      const merged = mergeReminderFlagRecords(flagsRef.current, remote)
      flagsRef.current = merged
      saveFlags(merged)
    }
    void mergeRemoteFlags()
    const onVis = () => {
      if (document.visibilityState === 'visible') void mergeRemoteFlags()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', mergeRemoteFlags)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', mergeRemoteFlags)
    }
  }, [])

  useEffect(() => {
    const tick = () => {
      const dateKey = todayKey()
      const { nextFlags, events } = runReminderTick({
        now: Date.now(),
        dateKey,
        medications,
        logs,
        flags: flagsRef.current,
      })

      flagsRef.current = nextFlags
      saveFlags(nextFlags)
      void syncReminderBundleToCache()

      const run = async () => {
        for (const ev of events) {
          if (ev.kind === 'first') {
            await playBeeps(1)
            if (notificationsEnabled) {
              await showMedicationNotification(
                ev.medicationName,
                ev.time,
                'first',
                slotKey(dateKey, ev.medicationId, ev.time),
              )
            }
          } else {
            await playBeeps(2)
            if (notificationsEnabled) {
              await showMedicationNotification(
                ev.medicationName,
                ev.time,
                'second',
                slotKey(dateKey, ev.medicationId, ev.time),
              )
            }
          }
        }
      }

      void run()
    }

    tick()
    const id = window.setInterval(tick, 15_000)
    return () => window.clearInterval(id)
  }, [medications, logs, notificationsEnabled])
}
