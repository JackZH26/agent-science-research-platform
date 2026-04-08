import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceBase, atomicWriteJSON } from './ipc-handlers';

// ============================================================
// AUTHOR HANDLERS (channel: 'authors:*')
// Persists to {workspace}/authors.json
// ============================================================

export interface AuthorRecord {
  id: string;
  name: string;
  title: string;        // Dr., Prof., etc.
  institution: string;
  email: string;
}

export interface ProjectAuthors {
  researchId: string;   // research ID or 'default'
  authorIds: string[];  // ordered list of author IDs
}

interface AuthorsData {
  authors: AuthorRecord[];
  projectDefaults: ProjectAuthors[];  // per-project default author assignments
}

function getAuthorsFile(): string {
  const workspace = getWorkspaceBase();
  const systemDir = path.join(workspace, 'system');
  if (!fs.existsSync(systemDir)) {
    fs.mkdirSync(systemDir, { recursive: true });
  }
  return path.join(systemDir, 'authors.json');
}

function loadAuthorsData(): AuthorsData {
  const filePath = getAuthorsFile();
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return {
        authors: Array.isArray(raw.authors) ? raw.authors : [],
        projectDefaults: Array.isArray(raw.projectDefaults) ? raw.projectDefaults : [],
      };
    }
  } catch { /* corrupted — start fresh */ }
  return { authors: [], projectDefaults: [] };
}

function saveAuthorsData(data: AuthorsData): void {
  const filePath = getAuthorsFile();
  atomicWriteJSON(filePath, data);
}

export function registerAuthorHandlers(): void {

  // List all authors
  ipcMain.handle('authors:list', async () => {
    const data = loadAuthorsData();
    return { authors: data.authors, projectDefaults: data.projectDefaults };
  });

  // Add or update an author
  ipcMain.handle('authors:save', async (_event, author: Record<string, unknown>) => {
    const data = loadAuthorsData();
    const id = typeof author.id === 'string' && author.id ? author.id : `A-${Date.now()}`;
    const record: AuthorRecord = {
      id,
      name: typeof author.name === 'string' ? author.name.trim() : '',
      title: typeof author.title === 'string' ? author.title.trim() : '',
      institution: typeof author.institution === 'string' ? author.institution.trim() : '',
      email: typeof author.email === 'string' ? author.email.trim() : '',
    };
    const idx = data.authors.findIndex(a => a.id === id);
    if (idx >= 0) {
      data.authors[idx] = record;
    } else {
      data.authors.push(record);
    }
    saveAuthorsData(data);
    return { success: true, id };
  });

  // Delete an author
  ipcMain.handle('authors:delete', async (_event, authorId: string) => {
    const data = loadAuthorsData();
    data.authors = data.authors.filter(a => a.id !== authorId);
    // Also remove from project defaults
    for (const pd of data.projectDefaults) {
      pd.authorIds = pd.authorIds.filter(id => id !== authorId);
    }
    saveAuthorsData(data);
    return { success: true };
  });

  // Set default authors for a research project (or 'default' for global default)
  ipcMain.handle('authors:set-project-defaults', async (_event, researchId: string, authorIds: string[]) => {
    const data = loadAuthorsData();
    const idx = data.projectDefaults.findIndex(pd => pd.researchId === researchId);
    if (idx >= 0) {
      data.projectDefaults[idx].authorIds = authorIds;
    } else {
      data.projectDefaults.push({ researchId, authorIds });
    }
    saveAuthorsData(data);
    return { success: true };
  });

  // Scan workspace for paper files and return structured list
  ipcMain.handle('papers:scan', async () => {
    const workspace = getWorkspaceBase();
    const results: Array<{
      researchId: string;
      researchLabel: string;
      papers: Array<{ name: string; path: string; size: number; modified: string }>;
    }> = [];

    // Scan researches/{id}/papers/
    const researchesDir = path.join(workspace, 'researches');
    if (fs.existsSync(researchesDir)) {
      const dirs = fs.readdirSync(researchesDir).filter(d =>
        fs.statSync(path.join(researchesDir, d)).isDirectory()
      );
      for (const dir of dirs) {
        const papersDir = path.join(researchesDir, dir, 'papers');
        if (fs.existsSync(papersDir)) {
          const files = scanPaperFiles(papersDir);
          if (files.length > 0) {
            results.push({ researchId: dir, researchLabel: dir, papers: files });
          }
        }
      }
    }

    // Scan general/papers/
    const generalDir = path.join(workspace, 'general', 'papers');
    if (fs.existsSync(generalDir)) {
      const files = scanPaperFiles(generalDir);
      results.push({ researchId: 'general', researchLabel: 'General', papers: files });
    }

    return { directories: results };
  });
}

function scanPaperFiles(dir: string): Array<{ name: string; path: string; size: number; modified: string }> {
  const files: Array<{ name: string; path: string; size: number; modified: string }> = [];
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        files.push({
          name: entry,
          path: fullPath,
          size: stat.size,
          modified: stat.mtime.toISOString().slice(0, 10),
        });
      }
    }
  } catch { /* ignore */ }
  return files.sort((a, b) => b.modified.localeCompare(a.modified));
}
