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

/**
 * Resolve the OpenRouter API key from all sources in priority order:
 * 1. Encrypted store (safeKeyStore)
 * 2. Environment variable OPENROUTER_KEY
 * 3. Legacy plaintext settings.json (auto-migrates to encrypted store)
 * 4. Cached trial key file
 * Returns empty string if no key is found.
 */
export function resolveOpenRouterKey(): string {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');

  // 1. Encrypted store
  const stored = getKey('openrouterKey');
  if (stored && !stored.includes('placeholder')) return stored;

  // 2. Env
  if (process.env.OPENROUTER_KEY) return process.env.OPENROUTER_KEY;

  // 3. Legacy settings.json (migrate on read)
  try {
    const settingsFile = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (s.openrouterKey && !s.openrouterKey.includes('placeholder')) {
        const key = s.openrouterKey as string;
        storeKey('openrouterKey', key);
        delete s.openrouterKey;
        fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2), 'utf-8');
        return key;
      }
    }
  } catch { /* ignore */ }

  // 4. Cached trial key
  try {
    const trialKeyFile = path.join(app.getPath('userData'), '.trial-key');
    if (fs.existsSync(trialKeyFile)) {
      return fs.readFileSync(trialKeyFile, 'utf-8').trim();
    }
  } catch { /* ignore */ }

  return '';
}
