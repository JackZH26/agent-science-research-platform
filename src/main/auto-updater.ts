// ============================================================
// Auto-Updater — ASRP
// Uses electron-updater for automatic update checks/installs.
// macOS: manual extract+replace (Squirrel.Mac requires code signing).
// ============================================================

import { app, BrowserWindow, dialog } from 'electron';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn } from 'child_process';

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
    // Disable Squirrel auto-install — we handle macOS updates manually
    this.lib.autoInstallOnAppQuit = process.platform !== 'darwin';

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
          message: `ASRP v${info.version} is available`,
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
   * macOS: Squirrel.Mac requires code-signed apps. Since the app is not
   * signed, we bypass Squirrel entirely and do a manual extract + replace:
   *   1. Find the downloaded ZIP in electron-updater's cache
   *   2. Extract it to a temp directory
   *   3. Spawn a detached shell script that waits for the app to quit,
   *      replaces the .app bundle, and relaunches
   *   4. Quit the app
   *
   * Windows/Linux: Use electron-updater's built-in quitAndInstall().
   */
  installUpdate(): void {
    if (!this.lib || !this.status.ready) {
      console.log('[Updater] installUpdate: not ready');
      return;
    }

    console.log('[Updater] === INSTALLING UPDATE ===');
    console.log('[Updater] Version:', this.status.version);
    console.log('[Updater] Platform:', process.platform);

    // Signal that we're quitting for update
    this.emit('before-quit-for-update');

    if (process.platform === 'darwin') {
      this._installMacUpdate();
    } else {
      // Windows/Linux: use electron-updater's built-in mechanism
      try {
        this.lib.quitAndInstall(false, true);
      } catch (err) {
        console.error('[Updater] quitAndInstall threw:', err);
        app.quit();
      }
      // Fallback: if still alive after 30s
      setTimeout(() => { app.quit(); }, 30000).unref();
    }
  }

  /**
   * macOS manual update: extract ZIP, replace .app, relaunch.
   * Bypasses Squirrel.Mac entirely (no code signing required).
   */
  private _installMacUpdate(): void {
    try {
      // 1. Find the downloaded update ZIP
      const cacheDir = path.join(app.getPath('userData').replace(/\/Application Support\/.*$/, '/Caches'), 'asrp-desktop-updater');
      const zipPath = path.join(cacheDir, 'update.zip');

      // Also check pending directory
      let actualZipPath = '';
      if (fs.existsSync(zipPath)) {
        actualZipPath = zipPath;
      } else {
        // Look for any ZIP in the pending dir
        const pendingDir = path.join(cacheDir, 'pending');
        if (fs.existsSync(pendingDir)) {
          const zips = fs.readdirSync(pendingDir).filter(f => f.endsWith('.zip'));
          if (zips.length > 0) {
            actualZipPath = path.join(pendingDir, zips[0]);
          }
        }
      }

      if (!actualZipPath) {
        console.error('[Updater] Cannot find downloaded update ZIP');
        this._showUpdateError('Cannot find downloaded update file. Please re-download.');
        return;
      }

      console.log('[Updater] Found update ZIP:', actualZipPath);

      // 2. Determine the current .app path and extract location
      const appPath = app.getPath('exe').replace(/\/Contents\/MacOS\/.*$/, '');
      const appName = path.basename(appPath); // "ASRP.app"
      const appDir = path.dirname(appPath);   // e.g. /Applications
      const extractDir = path.join(app.getPath('temp'), 'asrp-update-extract');

      console.log('[Updater] Current app:', appPath);
      console.log('[Updater] App directory:', appDir);

      // 3. Extract the ZIP to temp
      if (fs.existsSync(extractDir)) {
        execSync(`rm -rf "${extractDir}"`, { timeout: 10000, stdio: 'pipe' });
      }
      fs.mkdirSync(extractDir, { recursive: true });

      console.log('[Updater] Extracting to:', extractDir);
      execSync(`unzip -q -o "${actualZipPath}" -d "${extractDir}"`, {
        timeout: 60000,
        stdio: 'pipe',
      });

      // Find the extracted .app (name may differ)
      const extractedApps = fs.readdirSync(extractDir).filter(f => f.endsWith('.app'));
      if (extractedApps.length === 0) {
        throw new Error('No .app found in update ZIP');
      }
      const extractedApp = path.join(extractDir, extractedApps[0]);
      console.log('[Updater] Extracted app:', extractedApp);

      // 4. Create a shell script to do the swap and relaunch
      //    The script waits for the current process to die, then replaces the app.
      const pid = process.pid;
      const scriptPath = path.join(app.getPath('temp'), 'asrp-update.sh');
      const newAppInPlace = path.join(appDir, appName);
      const backupPath = path.join(appDir, `${appName}.bak`);
      const macosExe = path.join(newAppInPlace, 'Contents', 'MacOS', appName.replace('.app', ''));

      const script = `#!/bin/bash
# ASRP updater script — auto-generated
set -e

echo "[ASRP Update] Waiting for app (PID ${pid}) to quit..."
# Wait for the old process to die (max 30s)
for i in $(seq 1 60); do
  if ! kill -0 ${pid} 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# Brief extra pause for file locks to release
sleep 1

echo "[ASRP Update] Replacing app bundle..."
# Remove old backup if exists
rm -rf "${backupPath}"

# Move current app to backup
if [ -d "${newAppInPlace}" ]; then
  mv "${newAppInPlace}" "${backupPath}"
fi

# Move new app into place
mv "${extractedApp}" "${newAppInPlace}"

# Remove quarantine attribute (macOS may block unsigned apps from Finder moves)
xattr -rd com.apple.quarantine "${newAppInPlace}" 2>/dev/null || true

echo "[ASRP Update] Relaunching app..."
# Relaunch the app
open "${newAppInPlace}"

# Cleanup
sleep 5
rm -rf "${extractDir}"
rm -rf "${backupPath}"
rm -f "${scriptPath}"

echo "[ASRP Update] Done."
`;

      fs.writeFileSync(scriptPath, script, { encoding: 'utf-8', mode: 0o755 });
      console.log('[Updater] Update script written to:', scriptPath);

      // 5. Spawn the script detached so it survives our quit
      const child = spawn('/bin/bash', [scriptPath], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
      console.log('[Updater] Spawned update script, PID:', child.pid);

      // 6. Quit the app — the script will replace it and relaunch
      setTimeout(() => {
        console.log('[Updater] Quitting for update...');
        app.quit();
      }, 500);

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[Updater] macOS update failed:', errMsg);
      this._showUpdateError(`Update failed: ${errMsg}`);
    }
  }

  private _showUpdateError(detail: string): void {
    const win = this.getWindow?.() ?? undefined;
    dialog.showMessageBox(win as BrowserWindow, {
      type: 'error',
      title: 'Update Failed',
      message: 'Could not install the update',
      detail,
      buttons: ['OK'],
    });
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
