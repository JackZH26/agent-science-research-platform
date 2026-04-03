// ============================================================
// Ollama Manager — T-069, T-070
// Manages local Ollama inference server and hardware detection.
// ============================================================

import * as os from 'os';
import * as http from 'http';
import { execSync, spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  models: string[];
  downloading: boolean;
  downloadProgress: number;
  downloadSpeed: string;
  downloadEta: string;
  downloadModel: string;
}

export interface HardwareInfo {
  ram: number;       // GB
  gpu: string;       // GPU name or 'none'
  gpuVram: number;   // GB (0 if no GPU)
  os: string;
  arch: string;
}

export type ModelRecommendation = 'recommended' | 'possible_slow' | 'not_recommended';

interface OllamaTag {
  name: string;
  size: number;
  modified_at: string;
}

interface OllamaTagsResponse {
  models: OllamaTag[];
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11434;
const DEFAULT_MODEL = 'gemma3:27b';

class OllamaManager extends EventEmitter {
  private pullProcess: ChildProcess | null = null;
  private downloadProgress = 0;
  private downloadSpeed = '';
  private downloadEta = '';
  private downloadModel = '';
  private isDownloading = false;
  private serveProcess: ChildProcess | null = null;
  // Issue #22: Flag to distinguish intentional cancel from error
  private isCancelled = false;

  // ---- T-069: detectOllama ----
  detectOllama(): boolean {
    try {
      const cmd = process.platform === 'win32' ? 'where ollama' : 'which ollama';
      const result = execSync(cmd, { timeout: 3000, stdio: 'pipe' });
      return result.toString().trim().length > 0;
    } catch {
      return false;
    }
  }

  // ---- T-069: isRunning ----
  async isRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get({
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/tags',
        timeout: 3000,
      }, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  // ---- T-069: installOllama ----
  installOllama(): { url: string; instructions: string } {
    const platform = process.platform;
    if (platform === 'darwin') {
      return {
        url: 'https://ollama.com/download/mac',
        instructions: 'Download and open the Ollama.dmg installer, then follow the on-screen instructions.',
      };
    } else if (platform === 'win32') {
      return {
        url: 'https://ollama.com/download/windows',
        instructions: 'Download and run OllamaSetup.exe, then restart this application.',
      };
    } else {
      return {
        url: 'https://ollama.com/download/linux',
        instructions: 'Run: curl -fsSL https://ollama.com/install.sh | sh',
      };
    }
  }

  // ---- T-069: listModels ----
  async listModels(): Promise<string[]> {
    return new Promise((resolve) => {
      const req = http.get({
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/tags',
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as OllamaTagsResponse;
            const names = (parsed.models || []).map((m: OllamaTag) => m.name);
            resolve(names);
          } catch {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });
  }

  // ---- T-069: pullModel ----
  async pullModel(modelName: string = DEFAULT_MODEL): Promise<void> {
    if (this.isDownloading) {
      throw new Error('A download is already in progress');
    }

    this.isDownloading = true;
    this.downloadProgress = 0;
    this.downloadSpeed = '';
    this.downloadEta = '';
    this.downloadModel = modelName;

    this.isCancelled = false; // Reset cancel flag for new pull

    return new Promise((resolve, reject) => {
      this.pullProcess = spawn('ollama', ['pull', modelName], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const parseProgress = (line: string) => {
        // Ollama pull output: "pulling manifest", "pulling layer X/Y", "XX% ▕█████...▏ X.X GB/s  Xs"
        const pctMatch = line.match(/(\d+)%/);
        if (pctMatch) {
          this.downloadProgress = parseInt(pctMatch[1], 10);
        }
        const speedMatch = line.match(/([\d.]+\s*[KMGT]B\/s)/i);
        if (speedMatch) {
          this.downloadSpeed = speedMatch[1];
        }
        const etaMatch = line.match(/(\d+[hms](?:\s*\d+[ms])?)\s*$/);
        if (etaMatch) {
          this.downloadEta = etaMatch[1];
        }

        this.emit('download-progress', {
          progress: this.downloadProgress,
          speed: this.downloadSpeed,
          eta: this.downloadEta,
          model: modelName,
          status: line.trim(),
        });
      };

      if (this.pullProcess.stdout) {
        this.pullProcess.stdout.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n').filter(Boolean);
          lines.forEach(parseProgress);
        });
      }
      if (this.pullProcess.stderr) {
        this.pullProcess.stderr.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n').filter(Boolean);
          lines.forEach(parseProgress);
        });
      }

      this.pullProcess.on('close', (code) => {
        this.isDownloading = false;
        this.pullProcess = null;
        // Issue #22: Don't emit download-error when the close is due to a cancel
        if (this.isCancelled) {
          this.isCancelled = false;
          resolve(); // Cancel already emitted 'download-cancelled'
          return;
        }
        if (code === 0) {
          this.downloadProgress = 100;
          this.emit('download-complete', { model: modelName });
          resolve();
        } else {
          const err = new Error(`ollama pull exited with code ${code}`);
          this.emit('download-error', { model: modelName, error: err.message });
          reject(err);
        }
      });

      this.pullProcess.on('error', (err) => {
        this.isDownloading = false;
        this.pullProcess = null;
        this.emit('download-error', { model: modelName, error: err.message });
        reject(err);
      });
    });
  }

  // ---- T-072: cancelPull ----
  cancelPull(): void {
    if (this.pullProcess) {
      // Issue #22: Set flag before kill so the close handler knows not to emit download-error
      this.isCancelled = true;
      this.pullProcess.kill('SIGTERM');
      this.pullProcess = null;
      this.isDownloading = false;
      this.emit('download-cancelled', { model: this.downloadModel });
    }
  }

  // ---- T-069: chat ----
  async chat(messages: OllamaChatMessage[], model: string = DEFAULT_MODEL): Promise<string> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ model, messages, stream: false });

      const req = http.request({
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 120000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { message?: { content?: string }; error?: string };
            if (parsed.error) {
              reject(new Error(parsed.error));
            } else {
              resolve(parsed.message?.content || '');
            }
          } catch {
            reject(new Error('Failed to parse Ollama response'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama chat timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ---- T-069: deleteModel ----
  async deleteModel(modelName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ name: modelName });
      const req = http.request({
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/delete',
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`Delete failed with status ${res.statusCode}`));
        }
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ---- T-075: startOllama / stopOllama ----
  // Issue #21: Poll health check instead of blind 2-second timeout
  startOllama(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.serveProcess = spawn('ollama', ['serve'], {
          detached: true,
          stdio: 'ignore',
        });
        this.serveProcess.unref();

        // Handle spawn error (e.g., ollama not in PATH)
        this.serveProcess.on('error', (err) => {
          reject(err);
        });

        // Poll isRunning() up to 10 seconds
        const maxAttempts = 20;
        const intervalMs = 500;
        let attempts = 0;

        const poll = () => {
          this.isRunning().then((running) => {
            if (running) {
              resolve();
            } else {
              attempts++;
              if (attempts >= maxAttempts) {
                reject(new Error('Ollama did not become ready within 10 seconds'));
              } else {
                setTimeout(poll, intervalMs);
              }
            }
          }).catch(() => {
            attempts++;
            if (attempts >= maxAttempts) {
              reject(new Error('Ollama health check timed out'));
            } else {
              setTimeout(poll, intervalMs);
            }
          });
        };

        // Start polling after a brief initial delay
        setTimeout(poll, 200);
      } catch (err) {
        reject(err);
      }
    });
  }

  stopOllama(): void {
    if (this.serveProcess) {
      this.serveProcess.kill('SIGTERM');
      this.serveProcess = null;
    }
  }

  // ---- T-069: getStatus ----
  async getStatus(): Promise<OllamaStatus> {
    const installed = this.detectOllama();
    const running = installed ? await this.isRunning() : false;
    const models = running ? await this.listModels() : [];

    return {
      installed,
      running,
      models,
      downloading: this.isDownloading,
      downloadProgress: this.downloadProgress,
      downloadSpeed: this.downloadSpeed,
      downloadEta: this.downloadEta,
      downloadModel: this.downloadModel,
    };
  }

  // ---- T-070: detectHardware ----
  detectHardware(): HardwareInfo {
    const ramBytes = os.totalmem();
    const ram = Math.round(ramBytes / (1024 ** 3));
    const platform = os.platform();
    const arch = os.arch();

    let gpu = 'none';
    let gpuVram = 0;

    try {
      if (platform === 'linux' || platform === 'win32') {
        // Try NVIDIA first
        const nvidiaSmi = execSync(
          'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader',
          { timeout: 5000, stdio: 'pipe' }
        ).toString().trim();

        const lines = nvidiaSmi.split('\n').filter(Boolean);
        if (lines.length > 0) {
          const [name, vramStr] = lines[0].split(',').map(s => s.trim());
          gpu = name;
          const vramMib = parseInt(vramStr.replace(/[^0-9]/g, ''), 10);
          gpuVram = Math.round(vramMib / 1024);
        }
      } else if (platform === 'darwin') {
        // Apple Silicon or AMD on Mac
        const profiler = execSync(
          'system_profiler SPDisplaysDataType',
          { timeout: 8000, stdio: 'pipe' }
        ).toString();

        const chipMatch = profiler.match(/Chipset Model:\s*(.+)/);
        if (chipMatch) gpu = chipMatch[1].trim();

        const vramMatch = profiler.match(/VRAM \(Total\):\s*(\d+)\s*MB/i);
        if (vramMatch) {
          gpuVram = Math.round(parseInt(vramMatch[1], 10) / 1024);
        }
        const vramGbMatch = profiler.match(/VRAM \(Total\):\s*(\d+)\s*GB/i);
        if (vramGbMatch) {
          gpuVram = parseInt(vramGbMatch[1], 10);
        }
      }
    } catch {
      // GPU detection failed — CPU only
    }

    return {
      ram,
      gpu,
      gpuVram,
      os: platform,
      arch,
    };
  }

  // ---- T-070: getRecommendation ----
  getRecommendation(hardware?: HardwareInfo): ModelRecommendation {
    const hw = hardware || this.detectHardware();

    if (hw.ram >= 32 && hw.gpuVram >= 16) return 'recommended';
    if (hw.ram >= 16 || hw.gpuVram >= 8) return 'possible_slow';
    return 'not_recommended';
  }
}

// Singleton instance
export const ollamaManager = new OllamaManager();
