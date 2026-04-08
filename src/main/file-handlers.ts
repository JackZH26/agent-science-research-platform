import { ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {
  isPathAllowed,
} from './ipc-handlers';

// ============================================================
// FILE HANDLERS (channel: 'files:*')
// ============================================================

export function registerFileHandlers(): void {
  // Issue #1 (CRITICAL): All file handlers now guard against path traversal

  ipcMain.handle('files:list', async (_event, dirPath: string) => {
    if (!isPathAllowed(dirPath)) {
      return { files: [], error: 'Path outside workspace' };
    }
    try {
      if (!fs.existsSync(dirPath)) return { files: [], error: 'Path not found' };
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const files = entries.map(e => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
        size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : 0,
      }));
      return { files };
    } catch (err: unknown) {
      return { files: [], error: String(err) };
    }
  });

  ipcMain.handle('files:read', async (_event, filePath: string) => {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: 'Path outside workspace' };
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, content };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('files:write', async (_event, filePath: string, content: string) => {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: 'Path outside workspace' };
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('files:delete', async (_event, filePath: string) => {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: 'Path outside workspace' };
    }
    try {
      fs.rmSync(filePath, { recursive: true, force: true });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  // Binary-safe file copy — source can be outside workspace (user-selected),
  // but destination must be inside workspace.
  ipcMain.handle('files:copy', async (_event, srcPath: string, destPath: string) => {
    if (!isPathAllowed(destPath)) {
      return { success: false, error: 'Destination outside workspace' };
    }
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('files:open-dialog', async (_event, options: Electron.OpenDialogOptions) => {
    return dialog.showOpenDialog(options || {});
  });

  ipcMain.handle('files:save-dialog', async (_event, options: Electron.SaveDialogOptions) => {
    return dialog.showSaveDialog(options || {});
  });
}
