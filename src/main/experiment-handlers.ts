import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceBase } from './ipc-handlers';

// ============================================================
// RESEARCH HANDLERS (channel: 'experiments:*')
// Persists researches to {workspace}/researches.json
// Creates per-research directories: {workspace}/researches/{id}/papers + files
// General (unassigned) folder: {workspace}/general/papers + files
// ============================================================

interface ResearchRecord {
  id: string;
  code: string;         // Short code like R001, R002 for cross-referencing
  title: string;
  abstract: string;
  tags: string[];
  status: string;       // registered | running | confirmed | refuted | archived
  created: string;
  score: number | null;
  result: string | null;
}

function getResearchesFile(): string {
  const workspace = getWorkspaceBase();
  const systemDir = path.join(workspace, 'system');
  if (!fs.existsSync(systemDir)) {
    fs.mkdirSync(systemDir, { recursive: true });
  }
  const newPath = path.join(systemDir, 'researches.json');
  // Migrate: if old location exists and new doesn't, move it
  const oldPath = path.join(workspace, 'researches.json');
  if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
  }
  return newPath;
}

/** Generate the next short code (R001, R002, ...) based on existing records */
function nextCode(records: Array<Record<string, unknown>>): string {
  let max = 0;
  for (const r of records) {
    const c = String(r.code || '');
    const m = c.match(/^R(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'R' + String(max + 1).padStart(3, '0');
}

function loadResearches(): ResearchRecord[] {
  const filePath = getResearchesFile();
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Array<Record<string, unknown>>;
      // Migrate old format records (hypothesis/metadata) to new format (abstract/tags)
      // Also backfill missing `code` field
      let migrated = false;
      let codeCounter = 0;
      // First pass: find highest existing code
      for (const r of raw) {
        const c = String(r.code || '');
        const m = c.match(/^R(\d+)$/);
        if (m) codeCounter = Math.max(codeCounter, parseInt(m[1], 10));
      }
      const records: ResearchRecord[] = raw.map(r => {
        let needsMigration = false;
        if (!r.abstract && (r.hypothesis || (r.metadata && typeof (r.metadata as Record<string,unknown>).title === 'string'))) {
          needsMigration = true;
        }
        if (!r.code) {
          needsMigration = true;
        }
        if (needsMigration) {
          migrated = true;
          const meta = (r.metadata || {}) as Record<string, unknown>;
          const code = r.code ? String(r.code) : 'R' + String(++codeCounter).padStart(3, '0');
          return {
            id: String(r.id || ''),
            code,
            title: String(r.title || meta.title || ''),
            abstract: String(r.abstract || r.hypothesis || ''),
            tags: Array.isArray(r.tags) ? r.tags as string[] : [],
            status: String(r.status || 'registered'),
            created: String(r.created || ''),
            score: typeof r.score === 'number' ? r.score : null,
            result: typeof r.result === 'string' ? r.result : null,
          };
        }
        return r as unknown as ResearchRecord;
      });
      if (migrated) {
        fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf-8');
      }
      return records;
    }
  } catch { /* corrupted file — start fresh */ }
  return [];
}

function saveResearches(records: ResearchRecord[]): void {
  const filePath = getResearchesFile();
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf-8');
}

/**
 * Create the directory structure for a research:
 *   {workspace}/researches/{id}/papers/
 *   {workspace}/researches/{id}/files/
 *   {workspace}/code/{id}/
 * Also ensures standard folders exist:
 *   {workspace}/general/papers/  + files/
 *   {workspace}/code/general/
 *   {workspace}/system/
 */
function ensureResearchDirs(researchId: string): void {
  const workspace = getWorkspaceBase();
  const dirs = [
    path.join(workspace, 'researches', researchId, 'papers'),
    path.join(workspace, 'researches', researchId, 'files'),
    path.join(workspace, 'code', researchId),
    path.join(workspace, 'general', 'papers'),
    path.join(workspace, 'general', 'files'),
    path.join(workspace, 'code', 'general'),
    path.join(workspace, 'system'),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
  // Migrate: move agent-* dirs from workspace root into system/
  // Also clean up old name-based agent dirs (they've been replaced by role-based dirs)
  try {
    const entries = fs.readdirSync(workspace);
    for (const entry of entries) {
      if (entry.startsWith('agent-')) {
        const src = path.join(workspace, entry);
        if (fs.statSync(src).isDirectory()) {
          const dest = path.join(workspace, 'system', entry);
          if (!fs.existsSync(dest)) {
            fs.renameSync(src, dest);
          } else {
            // Destination exists; copy SOUL.md if missing, then remove old dir
            const oldSoul = path.join(src, 'SOUL.md');
            const newSoul = path.join(dest, 'SOUL.md');
            if (fs.existsSync(oldSoul) && !fs.existsSync(newSoul)) {
              fs.copyFileSync(oldSoul, newSoul);
            }
            fs.rmSync(src, { recursive: true, force: true });
          }
        }
      }
    }
  } catch { /* ignore migration errors */ }
}

export function registerExperimentHandlers(): void {

  ipcMain.handle('experiments:list', async () => {
    const records = loadResearches();
    // Ensure directory structure exists for all records
    for (const r of records) {
      ensureResearchDirs(r.id);
    }
    // Also ensure general folder
    const workspace = getWorkspaceBase();
    for (const sub of ['general/papers', 'general/files']) {
      const d = path.join(workspace, sub);
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
    return { experiments: records };
  });

  ipcMain.handle('experiments:get', async (_event, expId: string) => {
    const records = loadResearches();
    const record = records.find(r => r.id === expId);
    if (!record) {
      return { success: false, error: 'Research not found' };
    }
    return { success: true, experiment: record };
  });

  ipcMain.handle('experiments:register', async (_event, _hypothesis: string, metadata: Record<string, unknown>) => {
    const records = loadResearches();
    const id = `EXP-${new Date().toISOString().slice(0, 10)}-${String(Math.floor(Math.random() * 900) + 100)}`;
    const code = nextCode(records as unknown as Array<Record<string, unknown>>);
    const record: ResearchRecord = {
      id,
      code,
      title: (typeof metadata.title === 'string') ? metadata.title.trim() : '',
      abstract: (typeof metadata.abstract === 'string') ? metadata.abstract.trim() : '',
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((t): t is string => typeof t === 'string') : [],
      status: 'registered',
      created: new Date().toISOString().slice(0, 10),
      score: null,
      result: null,
    };

    records.unshift(record);
    saveResearches(records);

    // Create per-research directory structure
    ensureResearchDirs(id);

    return { success: true, id, code, title: record.title };
  });

  // Edit a research record (title, abstract, tags)
  ipcMain.handle('experiments:update', async (_event, expId: string, data: Record<string, unknown>) => {
    const records = loadResearches();
    const record = records.find(r => r.id === expId);
    if (!record) {
      return { success: false, error: 'Research not found' };
    }
    if (typeof data.title === 'string') record.title = data.title.trim();
    if (typeof data.abstract === 'string') record.abstract = data.abstract.trim();
    if (Array.isArray(data.tags)) record.tags = data.tags.filter((t): t is string => typeof t === 'string');
    if (typeof data.status === 'string') record.status = data.status;
    if (typeof data.score === 'number') record.score = data.score;
    if (typeof data.result === 'string') record.result = data.result;
    saveResearches(records);
    return { success: true };
  });

  ipcMain.handle('experiments:update-status', async (_event, expId: string, status: string, extra?: Record<string, unknown>) => {
    const records = loadResearches();
    const record = records.find(r => r.id === expId);
    if (!record) {
      return { success: false, error: 'Research not found' };
    }
    record.status = status;
    if (extra) {
      if (typeof extra.score === 'number') record.score = extra.score;
      if (typeof extra.result === 'string') record.result = extra.result;
    }
    saveResearches(records);
    return { success: true, expId, status };
  });
}
