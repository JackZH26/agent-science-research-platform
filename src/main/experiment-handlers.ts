import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getWorkspaceBase, atomicWriteJSON, withAuth } from './ipc-handlers';
import { bootstrapWorkflow } from './research-workflow';

// ============================================================
// RESEARCH HANDLERS (channel: 'experiments:*')
// Persists researches to {workspace}/researches.json
// Creates per-research directories: {workspace}/researches/{id}/papers + files
// General (unassigned) folder: {workspace}/general/papers + files
// ============================================================

export interface ResearchRecord {
  id: string;
  code: string;         // Short code like R001, R002 for cross-referencing
  title: string;
  abstract: string;
  tags: string[];
  status: string;       // registered | running | confirmed | refuted | archived
  created: string;
  score: number | null;
  result: string | null;
  isSample?: boolean;   // Whether this is a bundled sample research
  sampleVersion?: number; // Version of sample data for sync updates
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

export function loadResearches(): ResearchRecord[] {
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
        atomicWriteJSON(filePath, records);
      }
      return records;
    }
  } catch { /* corrupted file — start fresh */ }
  return [];
}

function saveResearches(records: ResearchRecord[]): void {
  const filePath = getResearchesFile();
  atomicWriteJSON(filePath, records);
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
  // Shallow migration: move any `{workspace}/agent-*` dir into `{workspace}/system/`.
  // This only relocates nickname-based legacy dirs up one level; the full
  // canonicalization to `system/agent-{role}/` (including renaming away
  // from the user's nickname) happens in `workspace-shared-dirs.selfHealAgentWorkspaces()`
  // when the gateway starts, where we have authoritative role info from settings.json.
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

/**
 * Sync sample researches from bundled resources.
 * Called on every experiments:list to ensure samples are up-to-date.
 * - Adds missing sample researches
 * - Updates outdated sample researches (based on sampleVersion)
 * - Syncs discoveries.json and papers.json
 */
function syncSampleResearches(): void {
  const workspace = getWorkspaceBase();

  // Resolve sample-researches dir: try extraResources first (packaged), then dev fallback
  const candidates = [
    path.join(process.resourcesPath, 'resources', 'sample-researches'), // packaged (extraResources)
    path.join(__dirname, '..', '..', 'resources', 'sample-researches'), // dev (project root)
  ];
  const sampleDir = candidates.find(p => fs.existsSync(p));

  if (!sampleDir) {
    console.log('[samples] No sample-researches directory found, tried:', candidates);
    return; // No samples to sync
  }

  try {
    const records = loadResearches();
    let modified = false;

    const sampleProjects = fs.readdirSync(sampleDir).filter(name => 
      fs.statSync(path.join(sampleDir, name)).isDirectory()
    );

    for (const projectDir of sampleProjects) {
      const projectPath = path.join(sampleDir, projectDir);
      const researchJsonPath = path.join(projectPath, 'research.json');
      
      if (!fs.existsSync(researchJsonPath)) continue;

      // Read bundled sample metadata
      const sampleData = JSON.parse(fs.readFileSync(researchJsonPath, 'utf-8')) as Record<string, unknown>;
      const sampleId = String(sampleData.id || '');
      const sampleVersion = typeof sampleData.sampleVersion === 'number' ? sampleData.sampleVersion : 1;

      // Check if this sample exists in workspace
      const existingIdx = records.findIndex(r => r.id === sampleId);

      if (existingIdx === -1) {
        // Sample doesn't exist → add it
        const newRecord: ResearchRecord = {
          id: sampleId,
          code: String(sampleData.code || ''),
          title: String(sampleData.title || ''),
          abstract: String(sampleData.abstract || ''),
          tags: Array.isArray(sampleData.tags) ? sampleData.tags.filter((t): t is string => typeof t === 'string') : [],
          status: String(sampleData.status || 'registered'),
          created: String(sampleData.created || new Date().toISOString().slice(0, 10)),
          score: null,
          result: null,
          isSample: true,
          sampleVersion,
        };
        records.push(newRecord);
        modified = true;
        console.log(`Added sample research: ${newRecord.code} - ${newRecord.title}`);

        // Create directory structure and sync files
        const researchDir = path.join(workspace, 'researches', sampleId);
        fs.mkdirSync(path.join(researchDir, 'papers'), { recursive: true });
        fs.mkdirSync(path.join(researchDir, 'files'), { recursive: true });
        syncSampleFiles(projectPath, researchDir);
      } else {
        // Sample exists → check if update needed
        const existing = records[existingIdx];
        const existingVersion = typeof existing.sampleVersion === 'number' ? existing.sampleVersion : 0;

        if (existingVersion < sampleVersion) {
          // Update outdated sample
          records[existingIdx] = {
            ...existing,
            code: String(sampleData.code || existing.code),
            title: String(sampleData.title || existing.title),
            abstract: String(sampleData.abstract || existing.abstract),
            tags: Array.isArray(sampleData.tags) ? sampleData.tags.filter((t): t is string => typeof t === 'string') : existing.tags,
            status: String(sampleData.status || existing.status),
            isSample: true,
            sampleVersion,
          };
          modified = true;
          console.log(`Updated sample research: ${existing.code} (v${existingVersion} → v${sampleVersion})`);

          // Sync files
          const researchDir = path.join(workspace, 'researches', sampleId);
          syncSampleFiles(projectPath, researchDir);
        }
      }
    }

    if (modified) {
      saveResearches(records);
    }
  } catch (err) {
    console.error('Failed to sync sample researches:', err);
  }
}

/**
 * Helper: Sync discoveries.json and papers.json from sample to workspace
 */
function syncSampleFiles(samplePath: string, workspacePath: string): void {
  const filesToSync = ['discoveries.json', 'papers.json'];
  for (const file of filesToSync) {
    const src = path.join(samplePath, file);
    const dest = path.join(workspacePath, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }
}

export function registerExperimentHandlers(): void {

  // Cache: track research IDs whose dirs have already been ensured this session
  const _ensuredDirIds = new Set<string>();
  let _generalDirsEnsured = false;

  ipcMain.handle('experiments:list', async () => {
    // Sync sample researches on every list call (fast JSON comparison)
    syncSampleResearches();

    const records = loadResearches();
    // Ensure directory structure exists only for new/unchecked records
    for (const r of records) {
      if (!_ensuredDirIds.has(r.id)) {
        ensureResearchDirs(r.id);
        _ensuredDirIds.add(r.id);
      }
    }
    // Also ensure general folder (once per session)
    if (!_generalDirsEnsured) {
      const workspace = getWorkspaceBase();
      for (const sub of ['general/papers', 'general/files']) {
        const d = path.join(workspace, sub);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      }
      _generalDirsEnsured = true;
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

  ipcMain.handle('experiments:register', withAuth(async (_userId: number, _hypothesis: string, metadata: Record<string, unknown>) => {
    const records = loadResearches();
    const id = `EXP-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
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
  }));

  // Start a research — register + bootstrap SRW workflow (Phase 0).
  // This is the new "Start Research" button entry point. It creates the record,
  // ensures dirs, creates the Discord channel, writes the kickoff inbox to the
  // Theorist, and posts a human-visible kickoff to the channel.
  ipcMain.handle('experiments:start-research', withAuth(async (_userId: number, metadata: Record<string, unknown>) => {
    const records = loadResearches();
    const id = `EXP-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
    const code = nextCode(records as unknown as Array<Record<string, unknown>>);
    const record: ResearchRecord = {
      id,
      code,
      title: (typeof metadata.title === 'string') ? metadata.title.trim() : '',
      abstract: (typeof metadata.abstract === 'string') ? metadata.abstract.trim() : '',
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((t): t is string => typeof t === 'string') : [],
      status: 'running',
      created: new Date().toISOString().slice(0, 10),
      score: null,
      result: null,
    };

    records.unshift(record);
    saveResearches(records);
    ensureResearchDirs(id);

    // Kick off SRW-v1 Phase 0 (bootstrap)
    try {
      const boot = await bootstrapWorkflow({
        id: record.id,
        code: record.code,
        title: record.title,
        abstract: record.abstract,
        tags: record.tags,
        status: record.status,
      });
      return {
        success: true,
        id,
        code,
        title: record.title,
        workflow: {
          phase: boot.state?.currentPhase || null,
          discordChannelId: boot.discordChannelId,
          discordChannelName: boot.discordChannelName,
          warnings: boot.warnings,
        },
      };
    } catch (err: unknown) {
      // Workflow bootstrap threw — record is registered but not actually
      // running. Revert status to 'draft' so the UI doesn't lie, and the
      // user can click Start again after fixing the underlying issue
      // (e.g. configuring the Discord bot token).
      const fresh = loadResearches();
      const recIdx = fresh.findIndex(r => r.id === id);
      if (recIdx >= 0) {
        fresh[recIdx].status = 'draft';
        saveResearches(fresh);
      }
      return {
        success: true,
        id,
        code,
        title: record.title,
        workflow: {
          phase: null,
          discordChannelId: null,
          discordChannelName: null,
          warnings: [`Workflow bootstrap failed: ${String(err)}`],
        },
      };
    }
  }));

  // Edit a research record (title, abstract, tags)
  ipcMain.handle('experiments:update', withAuth(async (_userId: number, expId: string, data: Record<string, unknown>) => {
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
  }));

  ipcMain.handle('experiments:update-status', withAuth(async (_userId: number, expId: string, status: string, extra?: Record<string, unknown>) => {
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
  }));
}
