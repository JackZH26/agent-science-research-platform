// ============================================================
// Workflow Migrator — backfills SRW-v1 state for existing researches
// ============================================================
// On app startup, every research that does not yet have a
// workflows/{id}/state.json file gets one written. The migrator
// runs bootstrapWorkflow() with skipDiscord=true and skipInbox=true
// so we don't accidentally create 396 Discord channels or flood
// agent inboxes on first launch.
//
// Researches migrated this way are tagged with
// `migratedFromLegacy: true` in their state, so the UI can show
// a "Migrated — not auto-dispatching" badge and the user can
// click Resume to start it properly later.
// ============================================================

import { loadResearches } from './experiment-handlers';
import {
  hasWorkflow,
  bootstrapWorkflow,
} from './research-workflow';

export interface MigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  errors: number;
}

/**
 * Runs the one-shot migration. Safe to call on every startup —
 * researches that already have a workflow state are skipped.
 */
export async function migrateExistingResearches(): Promise<MigrationResult> {
  const result: MigrationResult = { total: 0, migrated: 0, skipped: 0, errors: 0 };

  let records;
  try {
    records = loadResearches();
  } catch {
    return result;
  }

  result.total = records.length;

  for (const r of records) {
    if (!r.id) { result.skipped++; continue; }
    if (hasWorkflow(r.id)) { result.skipped++; continue; }

    try {
      await bootstrapWorkflow(
        {
          id: r.id,
          code: r.code,
          title: r.title,
          abstract: r.abstract,
          tags: r.tags,
          status: r.status,
        },
        {
          skipDiscord: true, // avoid mass channel creation
          skipInbox: true,   // avoid flooding agent inboxes
          migrated: true,
        },
      );
      result.migrated++;
    } catch (err) {
      console.error(`[workflow-migrator] Failed to bootstrap ${r.id}:`, err);
      result.errors++;
    }
  }

  console.log(`[workflow-migrator] total=${result.total} migrated=${result.migrated} skipped=${result.skipped} errors=${result.errors}`);
  return result;
}
