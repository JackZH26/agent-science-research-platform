import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceBase } from './ipc-handlers';

// ============================================================
// RESEARCH HANDLERS (channel: 'experiments:*')
// Persists researches to {workspace}/researches.json
// ============================================================

interface ResearchRecord {
  id: string;
  title: string;
  abstract: string;
  tags: string[];
  status: string;
  created: string;
  score: number | null;
  result: string | null;
}

function getResearchesFile(): string {
  const workspace = getWorkspaceBase();
  if (!fs.existsSync(workspace)) {
    fs.mkdirSync(workspace, { recursive: true });
  }
  return path.join(workspace, 'researches.json');
}

function loadResearches(): ResearchRecord[] {
  const filePath = getResearchesFile();
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ResearchRecord[];
    }
  } catch { /* corrupted file — start fresh */ }
  return [];
}

function saveResearches(records: ResearchRecord[]): void {
  const filePath = getResearchesFile();
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf-8');
}

export function registerExperimentHandlers(): void {

  ipcMain.handle('experiments:list', async () => {
    const records = loadResearches();
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
    const id = `EXP-${new Date().toISOString().slice(0, 10)}-${String(Math.floor(Math.random() * 900) + 100)}`;
    const record: ResearchRecord = {
      id,
      title: (typeof metadata.title === 'string') ? metadata.title.trim() : '',
      abstract: (typeof metadata.abstract === 'string') ? metadata.abstract.trim() : '',
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((t): t is string => typeof t === 'string') : [],
      status: 'registered',
      created: new Date().toISOString().slice(0, 10),
      score: null,
      result: null,
    };

    const records = loadResearches();
    records.unshift(record);
    saveResearches(records);

    return { success: true, id, title: record.title };
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
