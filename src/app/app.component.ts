import { Component, OnDestroy, OnInit } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { Subscription } from 'rxjs';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const INSTALL_DISMISS_KEY = 'medtracker:pwaInstallDismissed';
const UPDATE_DISMISS_KEY = 'medtracker:pwaUpdateDismissedHash';
const UPDATE_SUPPRESS_UNTIL_KEY = 'medtracker:pwaUpdateSuppressUntil';

function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIosStandalonePwa(): boolean {
  const ua = window.navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua);
  return isIos && isStandaloneDisplay();
}

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent {
  showInstallUi = false;
  showUpdateUi = false;
  isApplyingUpdate = false;
  showManualUpdateHint = false;
  isIosManualUpdateFlow = false;

  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private updateSub: Subscription | null = null;
  private checkIntervalId: number | null = null;
  private pendingVersionHash: string | null = null;

  constructor(private swUpdate: SwUpdate) {}

  ngOnInit(): void {
    this.setupInstallPrompt();
    this.setupUpdatePrompt();
  }

  ngOnDestroy(): void {
    if (this.updateSub) this.updateSub.unsubscribe();
    if (this.checkIntervalId !== null) window.clearInterval(this.checkIntervalId);
  }

  private setupInstallPrompt(): void {
    if (isStandaloneDisplay()) return;

    const dismissed = localStorage.getItem(INSTALL_DISMISS_KEY) === '1';
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.deferredPrompt = event as BeforeInstallPromptEvent;
      if (!dismissed) this.showInstallUi = true;
    });
  }

  private setupUpdatePrompt(): void {
    if (!this.swUpdate.isEnabled) return;

    this.updateSub = this.swUpdate.versionUpdates.subscribe((event) => {
      if (event.type !== 'VERSION_READY') return;

      const readyEvent = event as VersionReadyEvent;
      this.pendingVersionHash = readyEvent.latestVersion.hash;

      if (this.isDismissedForHash(this.pendingVersionHash) || this.isUpdateTemporarilySuppressed()) {
        return;
      }

      this.showManualUpdateHint = false;
      this.isApplyingUpdate = false;
      this.isIosManualUpdateFlow = isIosStandalonePwa();
      this.showUpdateUi = true;
    });

    void this.swUpdate.checkForUpdate().catch(() => undefined);
    this.checkIntervalId = window.setInterval(() => {
      void this.swUpdate.checkForUpdate().catch(() => undefined);
    }, 60 * 60 * 1000);
  }

  private isDismissedForHash(hash: string | null): boolean {
    if (!hash) return false;
    return localStorage.getItem(UPDATE_DISMISS_KEY) === hash;
  }

  private isUpdateTemporarilySuppressed(): boolean {
    const raw = localStorage.getItem(UPDATE_SUPPRESS_UNTIL_KEY);
    if (!raw) return false;
    const until = Number(raw);
    return Number.isFinite(until) && until > Date.now();
  }

  dismissInstallBanner(): void {
    localStorage.setItem(INSTALL_DISMISS_KEY, '1');
    this.showInstallUi = false;
    this.deferredPrompt = null;
  }

  async installApp(): Promise<void> {
    if (!this.deferredPrompt) return;
    await this.deferredPrompt.prompt();
    await this.deferredPrompt.userChoice;
    localStorage.setItem(INSTALL_DISMISS_KEY, '1');
    this.deferredPrompt = null;
    this.showInstallUi = false;
  }

  dismissUpdateBanner(): void {
    if (this.pendingVersionHash) {
      localStorage.setItem(UPDATE_DISMISS_KEY, this.pendingVersionHash);
    }
    this.showUpdateUi = false;
    this.showManualUpdateHint = false;
    this.isApplyingUpdate = false;
    this.isIosManualUpdateFlow = false;
  }

  async applyUpdate(): Promise<void> {
    if (this.isApplyingUpdate) return;

    if (isIosStandalonePwa() && this.showManualUpdateHint) {
      window.location.reload();
      return;
    }

    this.isApplyingUpdate = true;
    localStorage.setItem(UPDATE_SUPPRESS_UNTIL_KEY, String(Date.now() + 10 * 60 * 1000));

    try {
      await this.swUpdate.activateUpdate();
      localStorage.removeItem(UPDATE_DISMISS_KEY);
      localStorage.removeItem(UPDATE_SUPPRESS_UNTIL_KEY);
      window.location.reload();
    } catch {
      this.isApplyingUpdate = false;
      this.showManualUpdateHint = true;
      this.showUpdateUi = true;
    }
  }
}
