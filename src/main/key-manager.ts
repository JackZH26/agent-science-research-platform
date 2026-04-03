import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

// Issue #6 (HIGH): Trial keys are PLACEHOLDER values only.
// ⚠️  SECURITY WARNING: Never replace these with real API keys.
//    Real keys embedded in compiled binaries can be extracted with `asar extract`
//    or `strings`. Implement server-side key distribution before production:
//    the app contacts an ASRP endpoint with a user token, the server distributes
//    a key. The key should be stored in the OS keychain, not in source code.
const TRIAL_KEYS = [
  'sk-or-trial-key-001-placeholder-asrp-2026',
  'sk-or-trial-key-002-placeholder-asrp-2026',
  'sk-or-trial-key-003-placeholder-asrp-2026',
  'sk-or-trial-key-004-placeholder-asrp-2026',
  'sk-or-trial-key-005-placeholder-asrp-2026',
];

let keyDb: Database.Database | null = null;

export function initKeyManager(db: Database.Database): void {
  keyDb = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS key_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      key_value TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function assignTrialKey(userId: number): { success: boolean; key?: string; error?: string } {
  if (!keyDb) return { success: false, error: 'Key manager not initialized' };

  const existing = keyDb.prepare(
    'SELECT key_value FROM key_assignments WHERE user_id = ?'
  ).get(userId) as { key_value: string } | undefined;

  if (existing) {
    return { success: true, key: existing.key_value };
  }

  const count = (
    keyDb.prepare('SELECT COUNT(*) as cnt FROM key_assignments').get() as { cnt: number }
  ).cnt;

  if (count >= TRIAL_KEYS.length) {
    return { success: false, error: 'No trial keys available' };
  }

  const key = TRIAL_KEYS[count];
  keyDb.prepare('INSERT INTO key_assignments (user_id, key_value) VALUES (?, ?)').run(userId, key);

  return { success: true, key };
}

export function getUserKey(userId: number): string | null {
  if (!keyDb) return null;
  const row = keyDb.prepare(
    'SELECT key_value FROM key_assignments WHERE user_id = ?'
  ).get(userId) as { key_value: string } | undefined;
  return row?.key_value ?? null;
}

export function validateKey(key: string): { valid: boolean; error?: string } {
  if (!key || key.length < 10) {
    return { valid: false, error: 'Key too short' };
  }
  if (!key.startsWith('sk-or-')) {
    return { valid: false, error: 'Not a valid OpenRouter key format (must start with sk-or-)' };
  }
  return { valid: true };
}

// Issue #17: Returns boolean to allow callers to detect and propagate failures
export function writeKeyToWorkspace(key: string, workspacePath: string): boolean {
  try {
    fs.mkdirSync(workspacePath, { recursive: true });
    const envPath = path.join(workspacePath, '.env');
    let content = '';

    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf-8');
      if (content.includes('OPENROUTER_API_KEY=')) {
        content = content.replace(/OPENROUTER_API_KEY=.*/g, `OPENROUTER_API_KEY=${key}`);
      } else {
        content += `\nOPENROUTER_API_KEY=${key}\n`;
      }
    } else {
      content = `OPENROUTER_API_KEY=${key}\n`;
    }

    fs.writeFileSync(envPath, content, 'utf-8');
    return true;
  } catch (err) {
    console.error('[KeyManager] Failed to write key to workspace:', err);
    return false;
  }
}
