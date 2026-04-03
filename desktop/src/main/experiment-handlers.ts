import { ipcMain } from 'electron';

// ============================================================
// EXPERIMENT HANDLERS (channel: 'experiments:*') — [DEMO STUB]
// ============================================================

export function registerExperimentHandlers(): void {
  // Issue #36: Use relative dates instead of hardcoded domain-specific dates
  const relDate = (daysAgo: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };

  ipcMain.handle('experiments:list', async () => {
    return {
      experiments: [
        { id: 'EXP-DEMO-003', hypothesis: 'Multi-well DD with exact KS gap at d=5,6,7', status: 'running', created: relDate(1) },
        { id: 'EXP-DEMO-002', hypothesis: 'Prime-spaced wells produce negative DD', status: 'refuted', created: relDate(2) },
        { id: 'EXP-DEMO-001', hypothesis: 'LDA overestimates 2e atom binding by >1%', status: 'confirmed', created: relDate(2) },
        { id: 'EXP-DEMO-005', hypothesis: 'Electron membrane model consistent with Stodolna 2013', status: 'confirmed', created: relDate(3) },
        { id: 'EXP-DEMO-004', hypothesis: 'Fibonacci lattice reduces DFT ill-conditioning', status: 'registered', created: relDate(1) },
      ],
    };
  });

  ipcMain.handle('experiments:get', async (_event, expId: string) => {
    return { success: true, experiment: { id: expId, data: {} } };
  });

  ipcMain.handle('experiments:register', async (_event, hypothesis: string, metadata: Record<string, unknown>) => {
    const id = `EXP-${new Date().toISOString().slice(0, 10)}-${String(Math.floor(Math.random() * 900) + 100)}`;
    return { success: true, id, hypothesis, metadata };
  });

  ipcMain.handle('experiments:update-status', async (_event, expId: string, status: string) => {
    return { success: true, expId, status };
  });
}
