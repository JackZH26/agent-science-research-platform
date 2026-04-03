import { ipcMain } from 'electron';

// ============================================================
// PAPER HANDLERS (channel: 'papers:*') — [DEMO STUB]
// ============================================================

export function registerPaperHandlers(): void {
  // Issue #36: Use relative dates so stubs don't become confusingly historical
  const relDate = (daysAgo: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };

  ipcMain.handle('papers:list', async () => {
    return {
      papers: [
        { id: 'paper-001', title: 'Multi-well double-delta DFT analysis', status: 'draft', created: relDate(2) },
        { id: 'paper-002', title: 'LDA binding energy corrections', status: 'submitted', created: relDate(6) },
      ],
    };
  });

  ipcMain.handle('papers:get', async (_event, paperId: string) => {
    return { success: true, paper: { id: paperId, content: '# Paper Content\n\n(stub)' } };
  });

  ipcMain.handle('papers:create', async (_event, metadata: Record<string, unknown>) => {
    return { success: true, paperId: `paper-${Date.now()}`, metadata };
  });

  ipcMain.handle('papers:update', async (_event, paperId: string, data: Record<string, unknown>) => {
    return { success: true, paperId, data };
  });

  ipcMain.handle('papers:export', async (_event, paperId: string, format: string) => {
    return { success: true, message: `Exported ${paperId} as ${format} (stub)` };
  });
}
