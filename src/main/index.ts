import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  ipcMain,
  globalShortcut,
  protocol,
  dialog,
} from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { registerIpcHandlers } from './ipc-handlers';
import * as openclawBridge from './openclaw-bridge';
import { autoUpdater } from './auto-updater';
import { openclawManager } from './openclaw-manager';
import { hasConfig } from './openclaw-config-generator';

// Build metadata (generated during prebuild)
let buildInfo = { commit: 'dev', date: 'dev' };
try {
  buildInfo = require('./build-info.json');
} catch {
  // Not available in dev mode
}

const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
let statusPollInterval: ReturnType<typeof setInterval> | null = null;
const APP_ROOT = path.join(__dirname, '..', '..');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ASRP Desktop',
    backgroundColor: '#f0f5f0',
    show: false,
    frame: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // Issue #28: Enable sandbox for reduced attack surface
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  // Load the renderer via custom protocol (sandbox-compatible)
  mainWindow.loadURL('app://asrp/index.html');

  // Show window gracefully
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (isDev) {
      mainWindow?.webContents.openDevTools();
    }
  });

  // Handle window close — minimize to tray instead
  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Hot reload in dev mode only — guard both the require and call behind isDev
  // to avoid unnecessary require() overhead in production builds
  if (isDev) {
    try {
      const reload = require('electron-reload');
      reload(APP_ROOT, {
        electron: path.join(APP_ROOT, 'node_modules', '.bin', 'electron'),
        hardResetMethod: 'exit',
        ignored: /node_modules|dist/,
      });
    } catch {
      // electron-reload not available in dev, skip silently
    }
  }
}

function createTray(): void {
  const iconPath = path.join(APP_ROOT, 'build', 'icon.png');
  let trayIcon = nativeImage.createFromPath(iconPath);

  // Fallback to empty icon if file not found
  if (trayIcon.isEmpty()) {
    trayIcon = nativeImage.createEmpty();
  }

  // Resize for tray
  if (!trayIcon.isEmpty()) {
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('ASRP Desktop');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show ASRP',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'New Experiment',
      click: () => {
        mainWindow?.show();
        mainWindow?.webContents.send('navigate', '/researches');
      },
    },
    {
      label: 'View Dashboard',
      click: () => {
        mainWindow?.show();
        mainWindow?.webContents.send('navigate', '/dashboard');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit ASRP',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });

  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function showAboutDialog(): void {
  const electronVersion = process.versions.electron || 'N/A';
  const chromiumVersion = process.versions.chrome || 'N/A';
  const nodeVersion = process.versions.node || 'N/A';
  const v8Version = process.versions.v8 || 'N/A';
  const appVersion = app.getVersion();
  const platform = `${os.type()} ${os.arch()} ${os.release()}`;

  const detail = [
    `Version: ${appVersion}`,
    `Commit: ${buildInfo.commit}`,
    `Date: ${buildInfo.date}`,
    ``,
    `Electron: ${electronVersion}`,
    `Chromium: ${chromiumVersion}`,
    `Node.js: ${nodeVersion}`,
    `V8: ${v8Version}`,
    `OS: ${platform}`,
  ].join('\n');

  const win = mainWindow ?? undefined;
  dialog.showMessageBox(win as BrowserWindow, {
    type: 'info',
    title: 'About ASRP Desktop',
    message: 'ASRP Desktop',
    detail,
    buttons: ['OK', 'Copy'],
    defaultId: 0,
    noLink: true,
  }).then(({ response }) => {
    if (response === 1) {
      // Copy to clipboard
      const { clipboard } = require('electron');
      clipboard.writeText(`ASRP Desktop\n${detail}`);
    }
  });
}

function createAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'ASRP',
      submenu: [
        { label: 'About ASRP Desktop', click: () => showAboutDialog() },
        {
          label: autoUpdater.getMenuLabel(),
          click: () => autoUpdater.getMenuAction()(),
        },
        { type: 'separator' },
        { label: 'Preferences', accelerator: 'CmdOrCtrl+,', click: () => {
          mainWindow?.webContents.send('navigate', '/settings');
        }},
        { type: 'separator' },
        { label: 'Hide ASRP', role: 'hide' },
        { label: 'Hide Others', role: 'hideOthers' },
        { type: 'separator' },
        { label: 'Quit', role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        // Issue #30: macOS-only roles guarded by platform check
        ...(process.platform === 'darwin' ? [
          { role: 'zoom' as const },
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => shell.openExternal('https://github.com/JackZH26/ASRP-JZIS'),
        },
        {
          label: 'Report Issue',
          click: () => shell.openExternal('https://github.com/JackZH26/ASRP-JZIS/issues'),
        },
      ],
    },
  ];

  // On non-macOS, remove the Apple menu
  if (process.platform !== 'darwin') {
    template.shift();
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Register custom protocol for sandbox-safe file loading
// Must be called before app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// App lifecycle
app.whenReady().then(() => {
  // Register app:// protocol handler to serve local files
  // Uses fs.readFileSync which transparently reads from asar archives
  const rendererRoot = path.join(APP_ROOT, 'src', 'renderer');

  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const filePath = path.normalize(path.join(rendererRoot, pathname));

    // Security: prevent path traversal (normalize + reject .. segments + startsWith check)
    if (pathname.includes('..') || !filePath.startsWith(rendererRoot)) {
      return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
    }

    try {
      // fs.readFileSync transparently handles asar archives
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': contentType },
      });
    } catch (err) {
      console.error(`[app://] Failed to load: ${filePath}`, err);
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
  });
  createWindow();
  createTray();
  createAppMenu();
  registerIpcHandlers();

  // T-083: Initialize auto-updater
  autoUpdater.initialize(() => mainWindow);

  // Rebuild menu when update state changes (e.g., "Check for Updates" → "Restart to Update")
  autoUpdater.on('menu-update-needed', () => {
    createAppMenu();
  });

  // When auto-updater is about to quit for install, perform full cleanup
  // so nothing blocks the quit: timers, child processes, shortcuts.
  autoUpdater.on('before-quit-for-update', () => {
    console.log('[ASRP] before-quit-for-update: cleaning up...');
    isQuitting = true;

    // Clear polling timer so it doesn't hold the event loop
    if (statusPollInterval) {
      clearInterval(statusPollInterval);
      statusPollInterval = null;
    }

    // Stop all OpenClaw gateway child processes
    openclawManager.stopAll();

    // Unregister global shortcuts
    globalShortcut.unregisterAll();

    console.log('[ASRP] Cleanup complete, ready for quit');
  });

  // T-027: Agent status polling every 30s
  // Issue #32: Store interval ID so it can be cleared on quit
  statusPollInterval = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const statuses = openclawBridge.getAgentStatuses();
      mainWindow.webContents.send('agents:status-update', statuses);
    }
  }, 30000);

  // T-037: Global shortcut Cmd/Ctrl+J to toggle assistant panel
  globalShortcut.register('CmdOrCtrl+J', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('assistant:toggle');
    }
  });

  // Auto-start OpenClaw gateways if configs exist (setup was completed)
  if (hasConfig()) {
    // startAll() auto-loads agents from settings.json if none registered
    openclawManager.startAll().then((res) => {
      const ok = res.results.filter(r => r.success).length;
      const fail = res.results.filter(r => !r.success).length;
      console.log(`[ASRP] OpenClaw gateways: ${ok} started, ${fail} failed`);
      res.results.filter(r => !r.success).forEach(r => {
        console.warn(`[ASRP]   ${r.name}: ${r.error}`);
      });
    }).catch((err) => {
      console.warn('[ASRP] OpenClaw gateway start error:', err);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  // Issue #32: Clear polling interval to prevent leaks
  if (statusPollInterval) clearInterval(statusPollInterval);
  // Stop all OpenClaw gateways on app quit
  openclawManager.stopAll();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Security: prevent new window creation
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const parsedUrl = new URL(url);
    // Allow file:// and app:// for local app pages
    if (parsedUrl.protocol !== 'file:' && parsedUrl.protocol !== 'app:') {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
});

export { mainWindow };
