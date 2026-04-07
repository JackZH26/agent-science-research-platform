// ============================================================
// Auto-Updater — ASRP Desktop
// Uses electron-updater for automatic update checks/installs.
// ============================================================

import { app, BrowserWindow, dialog } from 'electron';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AutoUpdaterLib = any;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

class AppAutoUpdater extends EventEmitter {
  private lib: AutoUpdaterLib = null;
  private status: UpdaterStatus = {
    checking: false, available: false, downloading: false,
    ready: false, version: null, progress: 0, error: null,
  };
  private initialized = false;
  private getWindow: (() => BrowserWindow | null) | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private manualCheck = false;
  private userDeferredUpdate = false;

  initialize(getWindow: () => BrowserWindow | null): void {
    if (this.initialized) return;
    this.initialized = true;
    this.getWindow = getWindow;

    try {
      const updaterPkg = require('electron-updater') as { autoUpdater: AutoUpdaterLib };
      this.lib = updaterPkg.autoUpdater;
    } catch {
      console.log('[Updater] electron-updater not available');
      return;
    }

    // CRITICAL: autoDownload=false, we control download timing
    this.lib.autoDownload = false;
    // CRITICAL: this ensures update installs when app quits normally
    this.lib.autoInstallOnAppQuit = true;

    // ── Events ──

    this.lib.on('checking-for-update', () => {
      this.status.checking = true;
      this.status.error = null;
      this._send('updater:status', this.getStatus());
    });

    this.lib.on('update-available', (info: { version: string }) => {
      this.status.checking = false;
      this.status.available = true;
      this.status.version = info.version;
      this._send('updater:status', this.getStatus());

      if (this.manualCheck) {
        // User clicked "Check for Updates" — auto-download
        this.manualCheck = false;
        this.downloadUpdate().catch(() => {});
      } else {
        // Startup check — ask user
        const win = this.getWindow?.() ?? undefined;
        dialog.showMessageBox(win as BrowserWindow, {
          type: 'info',
          title: 'Update Available',
          message: `ASRP Desktop v${info.version} is available`,
          detail: `Current: v${app.getVersion()}`,
          buttons: ['Download Now', 'Later'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) {
            this.downloadUpdate().catch(() => {});
          } else {
            this.userDeferredUpdate = true;
          }
        });
      }
      this._updateMenu();
    });

    this.lib.on('update-not-available', () => {
      this.status.checking = false;
      this.status.available = false;
      this._send('updater:status', this.getStatus());
      if (this.manualCheck) {
        this.manualCheck = false;
        const win = this.getWindow?.() ?? undefined;
        dialog.showMessageBox(win as BrowserWindow, {
          type: 'info', title: 'Up to Date',
          message: `v${app.getVersion()} is the latest version.`,
          buttons: ['OK'],
        });
      }
    });

    this.lib.on('download-progress', (progress: { percent: number }) => {
      this.status.downloading = true;
      this.status.progress = Math.round(progress.percent);
      this._send('updater:status', this.getStatus());
    });

    this.lib.on('update-downloaded', (info: { version: string }) => {
      this.status.downloading = false;
      this.status.ready = true;
      this.status.version = info.version;
      this.status.progress = 100;
      this._send('updater:status', this.getStatus());

      console.log('[Updater] Update downloaded:', info.version);

      if (!this.userDeferredUpdate) {
        const win = this.getWindow?.() ?? undefined;
        dialog.showMessageBox(win as BrowserWindow, {
          type: 'info',
          title: 'Update Ready',
          message: `v${info.version} is ready to install`,
          detail: 'The app will quit, install the update, and relaunch. This may take a few seconds.',
          buttons: ['Restart Now', 'Later'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) this.installUpdate();
        });
      }
      this._updateMenu();
    });

    this.lib.on('error', (err: Error) => {
      this.status.checking = false;
      this.status.downloading = false;
      this.status.error = err.message;
      this._send('updater:status', this.getStatus());
      console.error('[Updater] Error:', err.message);
      if (this.manualCheck) {
        this.manualCheck = false;
        const win = this.getWindow?.() ?? undefined;
        dialog.showMessageBox(win as BrowserWindow, {
          type: 'error', title: 'Update Error',
          message: 'Update check failed', detail: err.message, buttons: ['OK'],
        });
      }
    });

    // Check on startup (10s delay)
    setTimeout(() => this.checkForUpdates().catch(() => {}), 10000);
    // Periodic check
    this.periodicTimer = setInterval(() => this.checkForUpdates().catch(() => {}), CHECK_INTERVAL_MS);

    // Cleanup timer on quit
    app.on('before-quit', () => {
      if (this.periodicTimer) clearInterval(this.periodicTimer);
    });
  }

  async checkForUpdatesManual(): Promise<void> {
    this.manualCheck = true;
    return this.checkForUpdates();
  }

  async checkForUpdates(): Promise<void> {
    if (!this.lib) return;
    try { await this.lib.checkForUpdates(); }
    catch (err) { this.status.error = err instanceof Error ? err.message : String(err); }
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
    }
  }

  /**
   * Install downloaded update.
   *
   * macOS (Squirrel.Mac) flow:
   *   1. electron-updater downloads ZIP and fires our `update-downloaded`
   *   2. Concurrently, it starts a local HTTP proxy and tells Squirrel.Mac
   *      to fetch the update from it (`nativeUpdater.checkForUpdates()`)
   *   3. Squirrel.Mac downloads from proxy → sets `squirrelDownloadedUpdate`
   *   4. On `quitAndInstall()`, if Squirrel finished → quits + ShipIt replaces .app
   *
   *   CRITICAL: We must NOT call `app.exit()` — it force-kills the process
   *   and bypasses Squirrel's ShipIt installation. We must let the quit
   *   complete through the normal lifecycle.
   *
   *   A delay before quitAndInstall gives Squirrel time to finish its
   *   internal download from the proxy (our `update-downloaded` event fires
   *   BEFORE Squirrel finishes).
   *
   * Windows/Linux: quitAndInstall() handles everything synchronously.
   */
  installUpdate(): void {
    if (!this.lib || !this.status.ready) {
      console.log('[Updater] installUpdate: not ready');
      return;
    }

    console.log('[Updater] === INSTALLING UPDATE ===');
    console.log('[Updater] Version:', this.status.version);
    console.log('[Updater] Platform:', process.platform);

    // Step 1: Signal that we're quitting for update.
    // Sets isQuitting=true so window close handlers don't minimize to tray.
    this.emit('before-quit-for-update');

    const doQuitAndInstall = () => {
      console.log('[Updater] Calling quitAndInstall()...');
      try {
        this.lib.quitAndInstall(false, true);
      } catch (err) {
        console.error('[Updater] quitAndInstall threw:', err);
        // Fallback: use app.quit() which triggers autoInstallOnAppQuit
        app.quit();
      }

      // Last-resort fallback: if still alive after 60s, use app.quit().
      // NEVER use app.exit() — it bypasses Squirrel's install on macOS.
      setTimeout(() => {
        console.log('[Updater] Still alive after 60s — calling app.quit()');
        app.quit();
      }, 60000).unref();
    };

    if (process.platform === 'darwin') {
      // On macOS, delay 5s to let Squirrel.Mac finish downloading
      // from the local proxy before triggering the quit sequence.
      console.log('[Updater] macOS: waiting 5s for Squirrel.Mac to stage update...');
      setTimeout(doQuitAndInstall, 5000);
    } else {
      doQuitAndInstall();
    }
  }

  getStatus(): UpdaterStatus { return { ...this.status }; }

  private _updateMenu(): void { this.emit('menu-update-needed'); }

  getMenuLabel(): string {
    if (this.status.ready) return `Restart to Update (v${this.status.version})`;
    if (this.status.downloading) return `Downloading... (${this.status.progress}%)`;
    if (this.status.available) return `Download Update (v${this.status.version})`;
    return 'Check for Updates...';
  }

  getMenuAction(): () => void {
    if (this.status.ready) return () => this.installUpdate();
    if (this.status.downloading) return () => {};
    if (this.status.available) return () => { this.downloadUpdate().catch(() => {}); };
    return () => { this.checkForUpdatesManual().catch(() => {}); };
  }

  private _send(channel: string, data: unknown): void {
    try {
      const win = this.getWindow?.();
      if (win && !win.isDestroyed()) win.webContents.send(channel, data);
    } catch { /* window gone */ }
  }
}

export const autoUpdater = new AppAutoUpdater();
