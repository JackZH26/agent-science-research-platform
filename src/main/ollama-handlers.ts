import { ipcMain, BrowserWindow } from 'electron';
import { ollamaManager } from './ollama-manager';

// ============================================================
// OLLAMA HANDLERS (channel: 'ollama:*')
// ============================================================

export function registerOllamaHandlers(): void {
  ipcMain.handle('ollama:status', async () => {
    try {
      return await ollamaManager.getStatus();
    } catch (err: unknown) {
      return { installed: false, running: false, models: [], downloading: false, downloadProgress: 0, downloadSpeed: '', downloadEta: '', downloadModel: '', error: String(err) };
    }
  });

  ipcMain.handle('ollama:detect-hardware', async () => {
    try {
      const hardware = ollamaManager.detectHardware();
      const recommendation = ollamaManager.getRecommendation(hardware);
      return { success: true, hardware, recommendation };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('ollama:pull-model', async (event, modelName: string = 'gemma3:27b') => {
    // L2: Validate modelName — only allow alphanumeric, colon, hyphen, dot, underscore
    if (typeof modelName !== 'string' || !/^[a-zA-Z0-9:.\-_]+$/.test(modelName) || modelName.length > 128) {
      return { success: false, error: 'Invalid model name' };
    }
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    const progressHandler = (data: unknown) => {
      if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.webContents.send('ollama:download-progress', data);
      }
    };
    const completeHandler = (data: unknown) => {
      if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.webContents.send('ollama:download-complete', data);
      }
      cleanup();
    };
    const errorHandler = (data: unknown) => {
      if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.webContents.send('ollama:download-error', data);
      }
      cleanup();
    };
    const cancelHandler = () => { cleanup(); };

    const cleanup = () => {
      ollamaManager.removeListener('download-progress', progressHandler);
      ollamaManager.removeListener('download-complete', completeHandler);
      ollamaManager.removeListener('download-error', errorHandler);
      ollamaManager.removeListener('download-cancelled', cancelHandler);
    };

    ollamaManager.on('download-progress', progressHandler);
    ollamaManager.on('download-complete', completeHandler);
    ollamaManager.on('download-error', errorHandler);
    ollamaManager.on('download-cancelled', cancelHandler);

    ollamaManager.pullModel(modelName).catch(() => { /* handled via events */ });

    return { success: true, message: `Pull started for ${modelName}` };
  });

  ipcMain.handle('ollama:cancel-pull', async () => {
    try {
      ollamaManager.cancelPull();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('ollama:list-models', async () => {
    try {
      const models = await ollamaManager.listModels();
      return { success: true, models };
    } catch (err: unknown) {
      return { success: false, models: [], error: String(err) };
    }
  });

  ipcMain.handle('ollama:chat', async (_event, messages: Array<{ role: string; content: string }>, model?: string) => {
    // Validate input: limit messages count and individual message length
    if (!Array.isArray(messages) || messages.length > 100) {
      return { success: false, reply: '', error: 'Too many messages (max 100)' };
    }
    const MAX_MSG_LEN = 50000;
    for (const m of messages) {
      if (typeof m.content !== 'string' || m.content.length > MAX_MSG_LEN) {
        return { success: false, reply: '', error: `Message too long (max ${MAX_MSG_LEN} chars)` };
      }
      if (!['system', 'user', 'assistant'].includes(m.role)) {
        return { success: false, reply: '', error: 'Invalid message role' };
      }
    }
    if (model && (typeof model !== 'string' || !/^[a-zA-Z0-9:.\-_]+$/.test(model) || model.length > 128)) {
      return { success: false, reply: '', error: 'Invalid model name' };
    }
    try {
      const reply = await ollamaManager.chat(
        messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        model
      );
      return { success: true, reply };
    } catch (err: unknown) {
      return { success: false, reply: '', error: String(err) };
    }
  });

  ipcMain.handle('ollama:delete-model', async (_event, modelName: string) => {
    // L2: Validate modelName — same check as pull-model
    if (typeof modelName !== 'string' || !/^[a-zA-Z0-9:.\-_]+$/.test(modelName) || modelName.length > 128) {
      return { success: false, error: 'Invalid model name' };
    }
    try {
      await ollamaManager.deleteModel(modelName);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('ollama:start', async () => {
    try {
      await ollamaManager.startOllama();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('ollama:stop', async () => {
    try {
      ollamaManager.stopOllama();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('ollama:install-instructions', async () => {
    return ollamaManager.installOllama();
  });
}
