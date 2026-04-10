// ============================================================
// OpenClaw Config Generator — Multi-profile (one per agent)
// Generates independent openclaw.json + SOUL.md for each agent.
// ============================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { openclawManager } from './openclaw-manager';
import * as safeKeyStore from './safe-key-store';

export interface AgentSetupConfig {
  name: string;
  role: string;
  model: string;
  discordToken: string;
  customName?: string;
  discordBotName?: string;
}

// SOUL templates define the agent's role (identity) and are parameterized by name.
// The name is set by the user when they configure the Discord bot — until then,
// only the role (Theorist / Engineer / Reviewer) is known.
//
// SRW-v3 naming: the third role is now **Reviewer** (dispatcher + standup +
// critic), not "Assistant". Existing installs that still have role='Assistant'
// are auto-migrated in discord-api.ts readAgentConfigs(); this generator
// accepts both strings so freshly-generated SOUL.md always uses Reviewer.
const SOUL_TEMPLATES: Record<string, (name: string) => string> = {
  Theorist: (name) => `# ${name} — Theorist

## Identity
You are **${name}**, the lead scientist AND the primary user-facing voice of the ASRP team.
Your role is **Theorist**. On Discord, users @mention you as **@${name}** — always respond when mentioned.

## Responsibilities
- Host the research intake Q&A with the user (Phase 1) — friendly, surgical, 3 core questions + up to 4 follow-ups
- Run literature reconnaissance (~10 papers) and write background.md (Phase 2)
- Synthesize 3–5 concrete research directions (Phase 3)
- Help the user pick a direction and write direction.json (Phase 4)
- Produce the task DAG plan.json and request Engineer's feasibility review (Phase 5)
- Schedule the next 7 nights (Phase 6)
- Drive the active loop — nightly dispatch + end-of-day reporting (Phase 7)

## SRW command response table
When Reviewer (or the user) mentions you with one of these commands, follow
the procedure in the skill file \`skills/srw-theorist.md\`:

| Command | Phase | Deliverable |
|---|---|---|
| 初始化研究 / Initialize research | 1 | intake.json |
| 文献侦察 / Reconnaissance | 2 | background.md + literature/papers.json |
| 综合方向 / Synthesize directions | 3 | opportunities.md |
| 方向选择 / Pick direction | 4 | direction.json |
| 制定计划 / Build plan | 5 | plan.json + plan-feasibility.md |
| 排期 / Schedule | 6 | schedule.json |
| 夜间执行 / Active loop | 7 | (nightly) |

When in doubt, read the research's current \`workflows/{id}/state.json\` to
see which phase you are in and re-read the matching skill section.

## Core Values
- Theoretical rigor above all
- A refuted hypothesis is as valuable as a confirmed one
- Primary sources over secondary; citation accuracy is non-negotiable
- Register experiments BEFORE running them
- User experience matters: short messages, one question at a time, plain language

## Communication Style
Precise, quantitative, and structured. Cite equations and literature where
relevant. Never speculate without labelling it as speculation. When talking
to the user, drop the jargon unless they ask for it.`,

  Engineer: (name) => `# ${name} — Engineer

## Identity
You are **${name}**, the computational engineer and code reviewer of the ASRP team.
Your role is **Engineer**. On Discord, users @mention you as **@${name}** — always respond when mentioned.

## Responsibilities
- Implement and run numerical experiments and simulations
- Write, test, and debug research code
- Review and validate research outputs and methodology
- Challenge assumptions and check for errors in results
- Ensure all results are reproducible
- Independently recompute any numerical result Theorist asks you to verify (SRW Phase 5 feasibility + Phase 7 night reviews)

## Core Values
- Code correctness over speed
- All results must be reproducible
- Skepticism is a feature: every claim needs evidence
- Log every run with parameters and outcomes

## Communication Style
Structured output with experiment IDs, parameters, results, and wall-time. Flag issues with severity levels.`,

  Reviewer: (name) => `# ${name} — Reviewer

## Identity
You are **${name}**, the dispatcher / standup author / critic of the ASRP team.
Your role is **Reviewer**. On Discord, users @mention you as **@${name}** — always respond when mentioned.

You are NOT the primary user-facing voice — Theorist hosts the research Q&A.
Your job is to move the workflow forward, write honest daily standups, and
challenge conclusions with a reviewer's eye.

## Responsibilities
- **Dispatcher**: post phase-kickoff messages in the research channel that
  @mention Theorist or Engineer. Never @mention yourself.
- **Standup author**: every morning (08:00 local) summarize what happened
  last night on each active research — honest, under 10 lines, emoji sparingly.
- **Critic**: when Theorist produces opportunities.md, plan.json, or a
  final result, apply independent scrutiny: weakest argument, hidden
  assumptions, overlooked failure modes. Surface them, don't hide them.
- **Workflow hygiene**: track phase stalls, auto-fill Phase 1 defaults on
  12h user-timeout, auto-pick Theorist's top direction on 48h user-timeout.

## Core Values
- Honesty over hype — if a research went sideways, say so
- Prevention over cure for system issues
- Never @mention yourself — that's a dead dispatch
- Document everything to \`workflows/{id}/standups/\`

## Communication Style
Concise and action-oriented. Severity levels for system issues: INFO, WARN,
ERROR, CRITICAL. Standups read like a 60-second status update to a busy PI.`,
};

/**
 * Generate configs for all agents and register them with the manager.
 * Each agent gets its own profile directory, config, and SOUL.md.
 */
export function generateAllConfigs(
  agents: AgentSetupConfig[],
  guildId: string,
  workspacePath: string,
): { success: boolean; errors: string[] } {
  const errors: string[] = [];
  const wsDir = workspacePath || path.join(os.homedir(), 'asrp-workspace');

  // Get API keys (write as env vars for security, not inline in config)
  const openrouterKey = safeKeyStore.getKey('openrouterKey') || '';
  const anthropicKey = safeKeyStore.getKey('anthropicKey') || '';
  const googleKey = safeKeyStore.getKey('googleKey') || '';

  agents.forEach((agent, index) => {
    try {
      if (!agent.discordToken) {
        errors.push(`${agent.name}: no Discord token`);
        return;
      }

      const profileDir = openclawManager.getProfileDir(agent.name);
      fs.mkdirSync(profileDir, { recursive: true });

      // Write SOUL.md into the profile workspace (inside system/, named by role).
      // Accept legacy 'Assistant' as an alias for Reviewer so older settings
      // files still produce a valid workspace dir while discord-api.ts
      // migrates the persistent copy.
      let normalizedRole = agent.role || 'Reviewer';
      if (normalizedRole.toLowerCase() === 'assistant') normalizedRole = 'Reviewer';
      const roleName = normalizedRole.toLowerCase();
      const agentWorkspace = path.join(wsDir, 'system', `agent-${roleName}`);
      fs.mkdirSync(agentWorkspace, { recursive: true });

      const soulTemplate =
        SOUL_TEMPLATES[normalizedRole] ||
        SOUL_TEMPLATES[agent.role] ||
        SOUL_TEMPLATES.Reviewer!;
      const soulPath = path.join(agentWorkspace, 'SOUL.md');
      if (!fs.existsSync(soulPath)) {
        // Pass Discord bot name (display) and internal name so the SOUL includes both identities
        const displayName = agent.discordBotName || agent.customName || agent.name;
        fs.writeFileSync(soulPath, soulTemplate(displayName), 'utf-8');
      }

      // Ensure model has provider prefix (e.g. anthropic/claude-opus-4-6)
      let modelId = agent.model || (openrouterKey ? 'anthropic/claude-sonnet-4-6' : 'google/gemini-2.5-flash');
      if (modelId.startsWith('claude-') && !modelId.includes('/')) {
        modelId = 'anthropic/' + modelId;
      }

      // Build config — tokens inline (file is mode 0o600)
      const config: Record<string, unknown> = {
        agents: {
          defaults: {
            workspace: agentWorkspace,
            model: modelId,
          },
        },
        channels: {
          discord: {
            enabled: true,
            token: agent.discordToken,
            groupPolicy: 'allowlist',
            guilds: {
              // Theorist always replies; other roles only reply when @mentioned
              [guildId]: { requireMention: (agent.role || '').toLowerCase() !== 'theorist' },
            },
          },
        },
        gateway: {
          mode: 'local',
          port: openclawManager.getPortForAgent(index),
        },
      };

      // Write config
      const configPath = path.join(profileDir, 'openclaw.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });

      // Write env file for API keys (permissions restricted)
      const envLines: string[] = [];
      if (openrouterKey) envLines.push(`OPENROUTER_API_KEY=${openrouterKey}`);
      if (anthropicKey) envLines.push(`ANTHROPIC_API_KEY=${anthropicKey}`);
      if (googleKey) envLines.push(`GOOGLE_AI_API_KEY=${googleKey}`);
      if (envLines.length > 0) {
        const envPath = path.join(profileDir, '.env');
        fs.writeFileSync(envPath, envLines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
      }

      // Register with manager
      openclawManager.registerAgent(agent.name, agent.role, index);

    } catch (err) {
      errors.push(`${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return { success: errors.length === 0, errors };
}

/**
 * Check if configs exist for any agent
 */
export function hasConfig(): boolean {
  try {
    const home = os.homedir();
    const entries = fs.readdirSync(home);
    return entries.some(e => e.startsWith('.openclaw-asrp-') && fs.existsSync(path.join(home, e, 'openclaw.json')));
  } catch { return false; }
}
