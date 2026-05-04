import { useCallback, useEffect, useState } from 'react'

const INSTALL_DISMISS_KEY = 'medtracker:pwaInstallDismissed'
const UPDATE_DISMISS_KEY = 'medtracker:pwaUpdateDismissedScript'
const UPDATE_SUPPRESS_UNTIL_KEY = 'medtracker:pwaUpdateSuppressUntil'

function isIosStandalonePwa(): boolean {
  const ua = window.navigator.userAgent || ''
  const isIos = /iPad|iPhone|iPod/.test(ua)
  return isIos && isStandaloneDisplay()
}

function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** Install banner (Android/Chrome) + update sheet when a new service worker is waiting. */
export function PwaPrompts() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showInstallUi, setShowInstallUi] = useState(false)
  const [showUpdateUi, setShowUpdateUi] = useState(false)
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false)
  const [showManualUpdateHint, setShowManualUpdateHint] = useState(false)
  const [isIosManualUpdateFlow, setIsIosManualUpdateFlow] = useState(false)

  const isDismissedForScript = useCallback((scriptUrl: string | null) => {
    if (!scriptUrl) return false
    return localStorage.getItem(UPDATE_DISMISS_KEY) === scriptUrl
  }, [])

  const dismissUpdateForScript = useCallback((scriptUrl: string | null) => {
    if (!scriptUrl) return
    localStorage.setItem(UPDATE_DISMISS_KEY, scriptUrl)
  }, [])

  const clearDismissedUpdate = useCallback(() => {
    localStorage.removeItem(UPDATE_DISMISS_KEY)
  }, [])

  const isUpdateTemporarilySuppressed = useCallback(() => {
    const raw = localStorage.getItem(UPDATE_SUPPRESS_UNTIL_KEY)
    if (!raw) return false
    const until = Number(raw)
    return Number.isFinite(until) && until > Date.now()
  }, [])

  const suppressUpdateBannerFor = useCallback((ms: number) => {
    localStorage.setItem(UPDATE_SUPPRESS_UNTIL_KEY, String(Date.now() + ms))
  }, [])

  const clearUpdateSuppression = useCallback(() => {
    localStorage.removeItem(UPDATE_SUPPRESS_UNTIL_KEY)
  }, [])

  useEffect(() => {
    if (isStandaloneDisplay()) return

    const dismissed = localStorage.getItem(INSTALL_DISMISS_KEY) === '1'

    const onBeforeInstall = (event: BeforeInstallPromptEvent) => {
      event.preventDefault()
      setDeferredPrompt(event)
      if (!dismissed) setShowInstallUi(true)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall)
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    let cancelled = false
    let intervalId: ReturnType<typeof setInterval> | undefined
    let showUpdateDelayId: ReturnType<typeof setTimeout> | undefined
    let registration: ServiceWorkerRegistration | undefined
    let updateFoundHandler: (() => void) | undefined

    const queueUpdateBanner = () => {
      if (showUpdateDelayId) {
        clearTimeout(showUpdateDelayId)
      }
      showUpdateDelayId = window.setTimeout(() => {
        if (!cancelled) {
          setIsApplyingUpdate(false)
          setShowManualUpdateHint(false)
          setShowUpdateUi(true)
        }
      }, 5000)
    }

    void navigator.serviceWorker.ready.then((reg) => {
      if (cancelled) return
      registration = reg

      const notifyIfWaiting = () => {
        const waitingScript = reg.waiting?.scriptURL ?? null
        if (
          reg.waiting &&
          navigator.serviceWorker.controller &&
          !isDismissedForScript(waitingScript) &&
          !isUpdateTemporarilySuppressed()
        ) {
          setIsIosManualUpdateFlow(isIosStandalonePwa())
          if (isIosStandalonePwa()) {
            setShowManualUpdateHint(true)
          }
          queueUpdateBanner()
        }
      }

      notifyIfWaiting()

      updateFoundHandler = () => {
        const nw = reg.installing
        if (!nw) return
        nw.addEventListener('statechange', () => {
          if (cancelled) return
          if (nw.state === 'installed' && navigator.serviceWorker.controller && reg.waiting) {
            clearDismissedUpdate()
            clearUpdateSuppression()
            setIsIosManualUpdateFlow(isIosStandalonePwa())
            if (isIosStandalonePwa()) {
              setShowManualUpdateHint(true)
            }
            queueUpdateBanner()
          }
        })
      }

      reg.addEventListener('updatefound', updateFoundHandler)

      void reg.update()
      intervalId = setInterval(() => void reg.update(), 60 * 60 * 1000)
    })

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
      if (showUpdateDelayId) clearTimeout(showUpdateDelayId)
      if (registration && updateFoundHandler) {
        registration.removeEventListener('updatefound', updateFoundHandler)
      }
    }
  }, [clearDismissedUpdate, clearUpdateSuppression, isDismissedForScript, isUpdateTemporarilySuppressed])

  const dismissInstallBanner = useCallback(() => {
    localStorage.setItem(INSTALL_DISMISS_KEY, '1')
    setShowInstallUi(false)
    setDeferredPrompt(null)
  }, [])

  const handleInstallClick = useCallback(async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    await deferredPrompt.userChoice
    setDeferredPrompt(null)
    setShowInstallUi(false)
    localStorage.setItem(INSTALL_DISMISS_KEY, '1')
  }, [deferredPrompt])

  const dismissUpdateBanner = useCallback(() => {
    void navigator.serviceWorker.getRegistration().then((reg) => {
      dismissUpdateForScript(reg?.waiting?.scriptURL ?? null)
      setIsApplyingUpdate(false)
      setShowManualUpdateHint(false)
      setIsIosManualUpdateFlow(false)
      setShowUpdateUi(false)
    })
  }, [dismissUpdateForScript])

  const handleApplyUpdate = useCallback(async () => {
    if (isApplyingUpdate) return

    if (isIosStandalonePwa()) {
      dismissUpdateBanner()
      return
    }

    setIsApplyingUpdate(true)
    setShowManualUpdateHint(false)
    suppressUpdateBannerFor(10 * 60 * 1000)

    let reloaded = false

    const safeReload = () => {
      if (reloaded) return
      reloaded = true
      window.location.reload()
    }

    const onControllerChange = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      safeReload()
    }

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    const reg = await navigator.serviceWorker.ready.catch(() => undefined)
    let waiting = reg?.waiting
    if (!waiting && reg) {
      await reg.update().catch(() => undefined)
      const startedAt = Date.now()
      while (!waiting && Date.now() - startedAt < 2000) {
        await new Promise((resolve) => window.setTimeout(resolve, 100))
        waiting = reg.waiting
      }
    }

    if (waiting) {
      clearDismissedUpdate()
      try {
        waiting.postMessage({ type: 'SKIP_WAITING' })
      } catch {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        setIsApplyingUpdate(false)
        setShowManualUpdateHint(true)
      }
    } else {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      setIsApplyingUpdate(false)
      setShowUpdateUi(false)
      return
    }

    // If iOS does not fire controllerchange in time, avoid reload-loop and show manual instruction.
    window.setTimeout(() => {
      if (reloaded) return
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      setIsApplyingUpdate(false)
      setShowManualUpdateHint(true)
      setShowUpdateUi(true)
    }, 12000)
  }, [clearDismissedUpdate, dismissUpdateBanner, isApplyingUpdate, suppressUpdateBannerFor])

  if (!showInstallUi && !showUpdateUi) return null

  return (
    <div className="pwa-toasts" aria-live="polite">
      {showUpdateUi && (
        <div className="pwa-banner pwa-banner--update" role="alertdialog" aria-labelledby="pwa-update-title">
          <div className="pwa-banner__body">
            <p id="pwa-update-title" className="pwa-banner__title">
              Update beschikbaar
            </p>
            <p className="pwa-banner__text">
              {showManualUpdateHint
                ? 'iOS blokkeert soms directe update. Sluit de app volledig in de app-switcher en open opnieuw.'
                : 'Er is een nieuwe versie van Medication Tracker. Vernieuw om de laatste verbeteringen te krijgen.'}
            </p>
          </div>
          <div className="pwa-banner__actions">
            <button type="button" className="pwa-banner__btn" onClick={dismissUpdateBanner}>
              Later
            </button>
            <button
              type="button"
              className="pwa-banner__btn pwa-banner__btn--primary"
              onClick={handleApplyUpdate}
              disabled={isApplyingUpdate}
            >
              {isApplyingUpdate
                ? 'Bezig...'
                : isIosManualUpdateFlow
                  ? 'Ik heb heropend'
                  : showManualUpdateHint
                    ? 'Opnieuw proberen'
                    : 'Nu vernieuwen'}
            </button>
          </div>
        </div>
      )}

      {showInstallUi && deferredPrompt && (
        <div className="pwa-banner pwa-banner--install" role="dialog" aria-labelledby="pwa-install-title">
          <div className="pwa-banner__body">
            <p id="pwa-install-title" className="pwa-banner__title">
              App installeren
            </p>
            <p className="pwa-banner__text">
              Voeg Medication Tracker toe aan je startscherm voor snellere toegang en een volledige
              schermervaring (Android / Chrome).
            </p>
          </div>
          <div className="pwa-banner__actions">
            <button type="button" className="pwa-banner__btn" onClick={dismissInstallBanner}>
              Later
            </button>
            <button
              type="button"
              className="pwa-banner__btn pwa-banner__btn--primary"
              onClick={() => void handleInstallClick()}
            >
              Installeren
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
