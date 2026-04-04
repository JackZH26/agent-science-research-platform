// ============================================================
// Safe Key Store — Encrypts API keys using Electron safeStorage
// Falls back to plaintext with a warning when safeStorage is unavailable
// (e.g., headless Linux without a keyring).
// ============================================================

import { safeStorage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

const KEYS_FILE = 'encrypted-keys.json';

interface StoredKeys {
  [keyName: string]: {
    encrypted: boolean;
    value: string; // base64 of encrypted buffer, or plaintext fallback
  };
}

function getKeysPath(): string {
  return path.join(app.getPath('userData'), KEYS_FILE);
}

function loadStore(): StoredKeys {
  try {
    const keysPath = getKeysPath();
    if (fs.existsSync(keysPath)) {
      return JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }
  return {};
}

function saveStore(store: StoredKeys): void {
  const keysPath = getKeysPath();
  fs.mkdirSync(path.dirname(keysPath), { recursive: true });
  fs.writeFileSync(keysPath, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Store an API key securely.
 * Uses safeStorage encryption when available, plaintext fallback otherwise.
 */
export function storeKey(keyName: string, keyValue: string): void {
  const store = loadStore();
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(keyValue);
    store[keyName] = { encrypted: true, value: encrypted.toString('base64') };
  } else {
    // Fallback: store plaintext (better than crashing, still file-permission protected)
    console.warn(`[SafeKeyStore] safeStorage unavailable — storing ${keyName} without encryption`);
    store[keyName] = { encrypted: false, value: keyValue };
  }
  saveStore(store);
}

/**
 * Retrieve a stored API key.
 * Returns null if the key doesn't exist.
 */
export function getKey(keyName: string): string | null {
  const store = loadStore();
  const entry = store[keyName];
  if (!entry) return null;

  if (entry.encrypted) {
    try {
      const buffer = Buffer.from(entry.value, 'base64');
      return safeStorage.decryptString(buffer);
    } catch {
      console.error(`[SafeKeyStore] Failed to decrypt ${keyName}`);
      return null;
    }
  }
  return entry.value;
}

/**
 * Remove a stored key.
 */
export function removeKey(keyName: string): void {
  const store = loadStore();
  delete store[keyName];
  saveStore(store);
}

/**
 * Check if encryption is available.
 */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}
