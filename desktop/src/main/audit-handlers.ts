import { ipcMain } from 'electron';

// ============================================================
// AUDIT HANDLERS (channel: 'audit:*') — [DEMO STUB]
// ============================================================

export function registerAuditHandlers(): void {
  // Issue #36: Use relative timestamps
  const relTime = (minutesAgo: number): string => {
    const t = new Date(Date.now() - minutesAgo * 60 * 1000);
    return t.toTimeString().slice(0, 5);
  };

  ipcMain.handle('audit:list', async (_event, options: { limit?: number; offset?: number }) => {
    const limit = options?.limit ?? 50;
    return {
      entries: [
        { time: relTime(0),  agent: 'Engineer', message: 'EXP-003: Exact KS gap computed for d=3.0, DD=+0.215', severity: 'info' },
        { time: relTime(5),  agent: 'Reviewer', message: 'EXP-002: DD sign depends on KS gap definition — verify with exact potential', severity: 'warning' },
        { time: relTime(18), agent: 'Theorist', message: 'Registered EXP-004: Fibonacci ill-conditioning hypothesis', severity: 'info' },
        { time: relTime(33), agent: 'System',   message: 'Daily backup completed (workspace: 2.4 MB)', severity: 'info' },
        { time: relTime(48), agent: 'Engineer', message: 'EXP-003: iDEA reverse engineering started (tol=1e-6, mu=3.0)', severity: 'info' },
        { time: relTime(63), agent: 'System',   message: 'Health check: all agents online, disk 23%', severity: 'info' },
      ].slice(0, limit),
      total: 6,
    };
  });

  ipcMain.handle('audit:log', async (_event, entry: Record<string, unknown>) => {
    return { success: true, entry };
  });

  ipcMain.handle('audit:export', async () => {
    return { success: true, message: 'Audit export stub' };
  });
}
