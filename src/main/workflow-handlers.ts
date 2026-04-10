// ============================================================
// Workflow IPC handlers — channel: 'workflows:*'
// ============================================================
// UI-facing IPC for the Workflow tab in the research detail page.
// Wraps the pure functions in research-workflow.ts with withAuth.
// ============================================================

import { ipcMain } from 'electron';
import * as fs from 'fs';
import { withAuth } from './ipc-handlers';
import {
  readWorkflowState,
  listWorkflows,
  pauseWorkflow,
  resumeWorkflow,
  stopWorkflow,
  markWorkflowComplete,
  bootstrapWorkflow,
  hasWorkflow,
  getWorkflowStateFile,
} from './research-workflow';
import { loadResearches } from './experiment-handlers';
import { runWorkflowSchedulerOnce } from './workflow-scheduler';

export function registerWorkflowHandlers(): void {
  // Get workflow state for a single research
  ipcMain.handle('workflows:get', withAuth(async (_userId: number, researchId: string) => {
    if (typeof researchId !== 'string' || !researchId) {
      return { success: false, error: 'Missing researchId' };
    }
    const state = readWorkflowState(researchId);
    if (!state) return { success: true, state: null };
    return { success: true, state };
  }));

  // List all workflows (for a global Workflow management page)
  ipcMain.handle('workflows:list', withAuth(async (_userId: number) => {
    return { success: true, workflows: listWorkflows() };
  }));

  // Pause / resume / stop / mark-complete
  ipcMain.handle('workflows:pause', withAuth(async (_userId: number, researchId: string) => {
    const s = pauseWorkflow(researchId);
    if (!s) return { success: false, error: 'Workflow not found' };
    return { success: true, state: s };
  }));

  ipcMain.handle('workflows:resume', withAuth(async (_userId: number, researchId: string) => {
    const s = resumeWorkflow(researchId);
    if (!s) return { success: false, error: 'Workflow not found' };
    return { success: true, state: s };
  }));

  ipcMain.handle('workflows:stop', withAuth(async (_userId: number, researchId: string) => {
    const s = stopWorkflow(researchId);
    if (!s) return { success: false, error: 'Workflow not found' };
    return { success: true, state: s };
  }));

  ipcMain.handle('workflows:mark-complete', withAuth(async (_userId: number, researchId: string) => {
    const s = markWorkflowComplete(researchId);
    if (!s) return { success: false, error: 'Workflow not found' };
    return { success: true, state: s };
  }));

  // Manually trigger one scheduler tick (useful for "Force refresh" in UI
  // and for tests). Returns immediately after the tick completes.
  ipcMain.handle('workflows:tick-now', withAuth(async (_userId: number) => {
    await runWorkflowSchedulerOnce();
    return { success: true };
  }));

  // Manually (re-)bootstrap a legacy/migrated research — this is how the
  // user "properly" starts a workflow for a research that was backfilled
  // without a Discord channel or kickoff inbox.
  ipcMain.handle('workflows:start', withAuth(async (_userId: number, researchId: string) => {
    if (typeof researchId !== 'string' || !researchId) {
      return { success: false, error: 'Missing researchId' };
    }
    const record = loadResearches().find(r => r.id === researchId);
    if (!record) return { success: false, error: 'Research not found' };

    // If a workflow already exists with a Discord channel, just resume it.
    if (hasWorkflow(researchId)) {
      const existing = readWorkflowState(researchId);
      if (existing && existing.discordChannelId && !existing.migratedFromLegacy) {
        // Already fully initialized — just unpause.
        const resumed = resumeWorkflow(researchId);
        return { success: true, state: resumed };
      }
      // Migrated/stub state: delete the stub and re-bootstrap.
      // We simply overwrite via bootstrapWorkflow after clearing the flag.
      // (bootstrapWorkflow returns existing state if present, so we have
      // to clear it first — easiest path: write a fresh one via the
      // legacy bypass below.)
    }

    // For migrated stubs, we force re-bootstrap by deleting the state file.
    // bootstrapWorkflow is idempotent, so we must remove the stub first
    // to actually run the full Discord-creation + kickoff path.
    try {
      const statePath = getWorkflowStateFile(researchId);
      if (fs.existsSync(statePath)) {
        const existing = readWorkflowState(researchId);
        if (existing?.migratedFromLegacy) {
          fs.unlinkSync(statePath);
        }
      }
    } catch { /* non-fatal */ }

    const boot = await bootstrapWorkflow({
      id: record.id,
      code: record.code,
      title: record.title,
      abstract: record.abstract,
      tags: record.tags,
      status: record.status,
    });
    return {
      success: boot.success,
      state: boot.state,
      discordChannelId: boot.discordChannelId,
      discordChannelName: boot.discordChannelName,
      warnings: boot.warnings,
    };
  }));
}
