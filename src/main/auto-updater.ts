// ============================================================
// Auto-Updater — ASRP Desktop
// Uses electron-updater for automatic update checks/installs.
// Loaded dynamically to avoid hard crash when not installed.
// ============================================================

import { app, BrowserWindow, Notification, dialog, Menu } from 'electron';
import { EventEmitter } from 'events';

export interface UpdaterStatus {
  checking: boolean;
  available: boolean;
  downloading: boolean;
  ready: boolean;
  version: string | null;
  progress: number;
  error: string | null;
}

type UpdaterEvent =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AutoUpdaterLib = any;

// Check interval: 4 hours
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

class AppAutoUpdater extends EventEmitter {
  private lib: AutoUpdaterLib = null;
  private status: UpdaterStatus = {
    checking: false,
    available: false,
    downloading: false,
    ready: false,
    version: null,
    progress: 0,
    error: null,
  };
  private initialized = false;
  private getWindow: (() => BrowserWindow | null) | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private manualCheck = false; // true when user clicked "Check for Updates..."

  initialize(getWindow: () => BrowserWindow | null): void {
    if (this.initialized) return;
    this.initialized = true;
    this.getWindow = getWindow;

    // Try to load electron-updater dynamically
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const updaterPkg = require('electron-updater') as { autoUpdater: AutoUpdaterLib };
      this.lib = updaterPkg.autoUpdater;
    } catch {
      // electron-updater not installed — updater is a no-op
      console.log('[AutoUpdater] electron-updater not available, updates disabled.');
      return;
    }

    this.lib.autoDownload = false;
    this.lib.autoInstallOnAppQuit = true;

    this.lib.on('checking-for-update' as UpdaterEvent, () => {
      this.status.checking = true;
      this.status.error = null;
      this._send('updater:status', this.getStatus());
    });

    this.lib.on('update-available' as UpdaterEvent, (info: { version: string }) => {
      this.status.checking = false;
      this.status.available = true;
      this.status.version = info.version;
      this._send('updater:status', this.getStatus());

      // Show dialog to user on startup auto-check
      if (!this.manualCheck) {
        const win = this.getWindow?.() ?? undefined;
        dialog.showMessageBox(win as BrowserWindow, {
          type: 'info',
          title: 'Update Available',
          message: `ASRP Desktop v${info.version} is available`,
          detail: `You are running v${app.getVersion()}. The update will download in the background and you\'ll be prompted to restart when ready.`,
          buttons: ['Download Now', 'Later'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) {
            this.downloadUpdate().catch(() => { /* handled by error event */ });
          }
        });
      }

      if (this.manualCheck) {
        this.manualCheck = false;
        this.downloadUpdate().catch(() => { /* handled by error event */ });
      }

      // Update the app menu to show update available
      this._updateMenu();
    });

    this.lib.on('update-not-available' as UpdaterEvent, () => {
      this.status.checking = false;
      this.status.available = false;
      this._send('updater:status', this.getStatus());

      if (this.manualCheck) {
        this.manualCheck = false;
        const win = this.getWindow?.() ?? undefined;
        dialog.showMessageBox(win as BrowserWindow, {
          type: 'info',
          title: 'No Updates',
          message: 'You\'re up to date!',
          detail: `ASRP Desktop v${app.getVersion()} is the latest version.`,
          buttons: ['OK'],
        });
      }
    });

    this.lib.on('download-progress' as UpdaterEvent, (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => {
      this.status.downloading = true;
      this.status.progress = Math.round(progress.percent);
      this._send('updater:status', this.getStatus());
    });

    this.lib.on('update-downloaded' as UpdaterEvent, (info: { version: string }) => {
      this.status.downloading = false;
      this.status.ready = true;
      this.status.version = info.version;
      this.status.progress = 100;
      this._send('updater:status', this.getStatus());

      // Show prominent dialog asking user to restart
      const win = this.getWindow?.() ?? undefined;
      dialog.showMessageBox(win as BrowserWindow, {
        type: 'info',
        title: 'Update Ready',
        message: `ASRP Desktop v${info.version} is ready to install`,
        detail: 'Restart now to apply the update, or restart later at your convenience.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          this.installUpdate();
        }
      });

      // Update menu
      this._updateMenu();
    });

    this.lib.on('error' as UpdaterEvent, (err: Error) => {
      this.status.checking = false;
      this.status.downloading = false;
      this.status.error = err.message;
      this._send('updater:status', this.getStatus());
      console.error('[AutoUpdater] Error:', err.message);

      if (this.manualCheck) {
        this.manualCheck = false;
        const win = this.getWindow?.() ?? undefined;
        dialog.showMessageBox(win as BrowserWindow, {
          type: 'error',
          title: 'Update Error',
          message: 'Failed to check for updates.',
          detail: err.message,
          buttons: ['OK'],
        });
      }
    });

    // Silent check after 10s on startup
    setTimeout(() => {
      this.checkForUpdates().catch(() => { /* ignore startup check errors */ });
    }, 10000);

    // Periodic check every 4 hours
    this.periodicTimer = setInterval(() => {
      this.checkForUpdates().catch(() => { /* ignore periodic check errors */ });
    }, CHECK_INTERVAL_MS);

    // Install on quit if update ready
    app.on('before-quit', () => {
      if (this.periodicTimer) clearInterval(this.periodicTimer);
      if (this.status.ready && this.lib) {
        this.lib.quitAndInstall(false, true);
      }
    });
  }

  /** Triggered by user clicking "Check for Updates..." in menu */
  async checkForUpdatesManual(): Promise<void> {
    this.manualCheck = true;
    return this.checkForUpdates();
  }

  async checkForUpdates(): Promise<void> {
    if (!this.lib) return;
    try {
      await this.lib.checkForUpdates();
    } catch (err) {
      this.status.error = err instanceof Error ? err.message : String(err);
    }
  }

  async downloadUpdate(): Promise<void> {
    if (!this.lib || !this.status.available) return;
    try {
      this.status.downloading = true;
      this._send('updater:status', this.getStatus());
      await this.lib.downloadUpdate();
    } catch (err) {
      this.status.downloading = false;
      this.status.error = err instanceof Error ? err.message : String(err);
      this._send('updater:status', this.getStatus());
      console.error('[AutoUpdater] Download failed:', this.status.error);
    }
  }

  installUpdate(): void {
    if (!this.lib || !this.status.ready) {
      console.log('[AutoUpdater] installUpdate called but not ready:', { lib: !!this.lib, ready: this.status.ready });
      return;
    }
    console.log('[AutoUpdater] Calling quitAndInstall...');
    // On macOS, setImmediate ensures the IPC response is sent before the app quits
    setImmediate(() => {
      try {
        this.lib.quitAndInstall(false, true);
      } catch (err) {
        console.error('[AutoUpdater] quitAndInstall failed:', err);
        // Fallback: force quit and let autoInstallOnAppQuit handle it
        app.quit();
      }
    });
  }

  getStatus(): UpdaterStatus {
    return { ...this.status };
  }

  /** Update the application menu to reflect update state */
  private _updateMenu(): void {
    // Emit event so index.ts can rebuild the menu
    this.emit('menu-update-needed');
  }

  /** Get the label for the update menu item */
  getMenuLabel(): string {
    if (this.status.ready) return `Restart to Update (v${this.status.version})`;
    if (this.status.downloading) return `Downloading Update... (${this.status.progress}%)`;
    if (this.status.available) return `Download Update (v${this.status.version})`;
    return 'Check for Updates...';
  }

  /** Get the menu click handler */
  getMenuAction(): () => void {
    if (this.status.ready) return () => this.installUpdate();
    if (this.status.downloading) return () => { /* downloading, no action */ };
    if (this.status.available) return () => { this.downloadUpdate().catch(() => {}); };
    return () => { this.checkForUpdatesManual().catch(() => {}); };
  }

  private _send(channel: string, data: unknown): void {
    try {
      const win = this.getWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // window may be gone
    }
  }
}

export const autoUpdater = new AppAutoUpdater();
