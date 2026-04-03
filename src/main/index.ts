import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  ipcMain,
  globalShortcut,
} from 'electron';
import * as path from 'path';
import { registerIpcHandlers } from './ipc-handlers';
import * as openclawBridge from './openclaw-bridge';
import { autoUpdater } from './auto-updater';

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

  // Load the renderer
  const rendererPath = path.join(APP_ROOT, 'src', 'renderer', 'index.html');
  mainWindow.loadFile(rendererPath);

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

  // Hot reload in dev mode
  if (isDev) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('electron-reload')(APP_ROOT, {
        electron: path.join(APP_ROOT, 'node_modules', '.bin', 'electron'),
        hardResetMethod: 'exit',
        ignored: /node_modules|dist/,
      });
    } catch {
      // electron-reload not available, skip
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
        mainWindow?.webContents.send('navigate', '/experiments');
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

function createAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'ASRP',
      submenu: [
        { label: 'About ASRP', role: 'about' },
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

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();
  createAppMenu();
  registerIpcHandlers();

  // T-083: Initialize auto-updater
  autoUpdater.initialize(() => mainWindow);

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
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Security: prevent new window creation
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const parsedUrl = new URL(url);
    // Allow file:// for local app pages
    if (parsedUrl.protocol !== 'file:') {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
});

export { mainWindow };
