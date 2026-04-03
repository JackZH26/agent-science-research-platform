import * as path from 'path';
import * as fs from 'fs';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { app } from 'electron';

// Issue #27: Generate a random JWT secret on first launch and persist it in userData.
// This ensures each installation has a unique secret and tokens from one machine
// cannot be replayed on another even if the database is copied.
let _jwtSecret: string | null = null;

function getJwtSecret(): string {
  if (_jwtSecret) return _jwtSecret;
  const secretPath = path.join(app.getPath('userData'), '.jwt-secret');
  try {
    if (fs.existsSync(secretPath)) {
      const secret = fs.readFileSync(secretPath, 'utf-8').trim();
      if (secret.length >= 32) {
        _jwtSecret = secret;
        return _jwtSecret;
      }
    }
  } catch { /* fall through to generate */ }

  // Generate a new random 64-char hex secret
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto') as typeof import('crypto');
  const newSecret = (crypto.randomBytes(32) as Buffer).toString('hex');
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, newSecret, { encoding: 'utf-8', mode: 0o600 });
  } catch { /* ignore write failure — still use in-memory secret */ }
  _jwtSecret = newSecret;
  return _jwtSecret;
}

const SALT_ROUNDS = 10;

// Issue #15: In-memory token revocation list.
// Tokens are local-only, so in-memory revocation is sufficient.
// The set is cleared on app restart which is acceptable for a desktop app.
const revokedTokens = new Set<string>();

// M4: Periodically prune expired tokens from the revocation set to prevent unbounded growth.
// JWT tokens expire after 30 days; we check once per hour.
setInterval(() => {
  for (const token of revokedTokens) {
    try {
      // jwt.decode does NOT verify signature — only used to read exp claim for pruning
      const decoded = jwt.decode(token) as { exp?: number } | null;
      if (!decoded || !decoded.exp) {
        revokedTokens.delete(token); // malformed token, safe to remove
      } else if (decoded.exp * 1000 < Date.now()) {
        revokedTokens.delete(token); // token already expired, no need to keep
      }
    } catch {
      revokedTokens.delete(token);
    }
  }
}, 60 * 60 * 1000); // every hour

export interface UserRecord {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  created_at: string;
  setup_complete: number;
}

export interface AuthResult {
  success: boolean;
  token?: string;
  user?: { id: number; name: string; email: string };
  error?: string;
}

export interface UserProfile {
  researchArea: string;
  specificTopic: string;
  paperName: string;
  institution: string;
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'asrp-auth.db');
  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      setup_complete INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      research_area TEXT DEFAULT '',
      specific_topic TEXT DEFAULT '',
      paper_name TEXT DEFAULT '',
      institution TEXT DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

export function register(name: string, email: string, password: string): AuthResult {
  try {
    // Issue #12: Enforce password strength and email validation
    if (!name || name.trim().length === 0) {
      return { success: false, error: 'Name is required' };
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, error: 'A valid email address is required' };
    }
    if (!password || password.length < 8) {
      return { success: false, error: 'Password must be at least 8 characters' };
    }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return { success: false, error: 'Password must contain at least one letter and one number' };
    }

    const database = getDb();
    const existing = database.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return { success: false, error: 'Email already registered' };
    }

    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    const result = database.prepare(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'
    ).run(name.trim(), email, hash);

    const userId = result.lastInsertRowid as number;
    const token = jwt.sign({ id: userId, email }, getJwtSecret(), { expiresIn: '30d' });

    return { success: true, token, user: { id: userId, name: name.trim(), email } };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}

export function login(email: string, password: string): AuthResult {
  try {
    const database = getDb();
    const user = database.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRecord | undefined;

    if (!user) {
      return { success: false, error: 'Invalid email or password' };
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return { success: false, error: 'Invalid email or password' };
    }

    const token = jwt.sign({ id: user.id, email }, getJwtSecret(), { expiresIn: '30d' });
    return {
      success: true,
      token,
      user: { id: user.id, name: user.name, email },
    };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}

// Issue #15: Logout adds the token to the revocation list so it cannot be reused
export function logout(token: string): { success: boolean } {
  if (token && token.length > 0) {
    revokedTokens.add(token);
  }
  return { success: true };
}

export function getUser(token: string): { id: number; name: string; email: string; setupComplete: boolean } | null {
  try {
    // Issue #15: Check revocation list before verifying
    if (revokedTokens.has(token)) return null;

    const decoded = jwt.verify(token, getJwtSecret()) as { id: number; email: string };
    const database = getDb();
    const user = database.prepare(
      'SELECT id, name, email, setup_complete FROM users WHERE id = ?'
    ).get(decoded.id) as UserRecord | undefined;

    if (!user) return null;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      setupComplete: user.setup_complete === 1,
    };
  } catch {
    return null;
  }
}

export function isSetupComplete(userId: number): boolean {
  const database = getDb();
  const user = database.prepare('SELECT setup_complete FROM users WHERE id = ?').get(userId) as
    | { setup_complete: number }
    | undefined;
  return user?.setup_complete === 1;
}

export function markSetupComplete(userId: number): void {
  const database = getDb();
  database.prepare('UPDATE users SET setup_complete = 1 WHERE id = ?').run(userId);
}

export function saveProfile(userId: number, profile: UserProfile): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO user_profiles (user_id, research_area, specific_topic, paper_name, institution, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      research_area = excluded.research_area,
      specific_topic = excluded.specific_topic,
      paper_name = excluded.paper_name,
      institution = excluded.institution,
      updated_at = excluded.updated_at
  `).run(userId, profile.researchArea, profile.specificTopic, profile.paperName, profile.institution);
}

export function getAuthDb(): Database.Database {
  return getDb();
}
