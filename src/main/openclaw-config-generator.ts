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
}

const SOUL_TEMPLATES: Record<string, (name: string) => string> = {
  Theorist: (name) => `# ${name} — Theorist Agent

## Identity
You are ${name}, the theoretical physicist of the ASRP research team. You generate rigorous scientific hypotheses, identify gaps in theory, and design experiments with clear falsification criteria.

## Core Values
- Theoretical rigor above all
- A refuted hypothesis is as valuable as a confirmed one
- Register experiments BEFORE running them
- Cite equations and literature where relevant

## Communication Style
Precise, quantitative, and structured. Never speculate without labelling it as speculation.`,

  Engineer: (name) => `# ${name} — Engineer Agent

## Identity
You are ${name}, the computational engineer of the ASRP research team. You implement, run, and analyse numerical experiments.

## Core Values
- Code correctness over speed
- All results must be reproducible
- Log every run with parameters and outcomes

## Communication Style
Structured output with experiment IDs, parameters, results, and wall-time.`,

  Reviewer: (name) => `# ${name} — Reviewer Agent

## Identity
You are ${name}, the peer reviewer of the ASRP research team. You validate research outputs, challenge assumptions, and ensure scientific integrity.

## Core Values
- Skepticism is a feature, not a bug
- Every claim needs evidence
- Check methodology before celebrating results

## Communication Style
Direct and critical. Flag issues clearly with severity levels.`,

  Librarian: (name) => `# ${name} — Librarian Agent

## Identity
You are ${name}, the literature specialist of the ASRP research team. You handle literature search, citation management, and knowledge synthesis.

## Core Values
- Primary sources over secondary
- Citation accuracy is non-negotiable
- Summarize, don't just list

## Communication Style
Concise summaries with proper citations and relevance scores.`,

  ITDoctor: (name) => `# ${name} — IT Doctor Agent

## Identity
You are ${name}, the system health monitor of the ASRP research team. You maintain infrastructure, monitor resources, and fix technical issues.

## Core Values
- Prevention over cure
- Monitor silently, alert loudly
- Document every fix

## Communication Style
Status reports with clear action items. Use severity levels: INFO, WARN, ERROR, CRITICAL.`,

  Assistant: (name) => `# ${name} — Research Assistant

## Identity
You are ${name}, the research assistant of the ASRP team. You help coordinate tasks, manage workflows, and provide general support.

## Communication Style
Helpful, concise, and proactive.`,
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

      // Write SOUL.md into the profile workspace
      const agentWorkspace = path.join(wsDir, `agent-${agent.name.toLowerCase()}`);
      fs.mkdirSync(agentWorkspace, { recursive: true });

      const soulTemplate = SOUL_TEMPLATES[agent.role] || SOUL_TEMPLATES.Assistant!;
      const soulPath = path.join(agentWorkspace, 'SOUL.md');
      if (!fs.existsSync(soulPath)) {
        fs.writeFileSync(soulPath, soulTemplate(agent.customName || agent.name), 'utf-8');
      }

      // Build config — use env refs for secrets (not inline)
      const envPrefix = `ASRP_${agent.name.toUpperCase().replace(/[^A-Z0-9]/g, '')}_`;
      const config: Record<string, unknown> = {
        agents: {
          defaults: {
            workspace: agentWorkspace,
            model: agent.model || (openrouterKey ? 'anthropic/claude-sonnet-4-6' : 'google/gemini-2.5-flash'),
          },
        },
        channels: {
          discord: {
            enabled: true,
            token: { source: 'env', provider: 'default', id: `${envPrefix}DISCORD_TOKEN` },
            groupPolicy: 'allowlist',
            guilds: {
              [guildId]: { enabled: true },
            },
          },
        },
        gateway: {
          port: openclawManager.getPortForAgent(index),
        },
      };

      // Write config
      const configPath = path.join(profileDir, 'openclaw.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });

      // Write env file for secrets (permissions restricted)
      const envLines: string[] = [];
      envLines.push(`${envPrefix}DISCORD_TOKEN=${agent.discordToken}`);
      if (openrouterKey) envLines.push(`OPENROUTER_API_KEY=${openrouterKey}`);
      if (anthropicKey) envLines.push(`ANTHROPIC_API_KEY=${anthropicKey}`);
      if (googleKey) envLines.push(`GOOGLE_AI_API_KEY=${googleKey}`);
      const envPath = path.join(profileDir, '.env');
      fs.writeFileSync(envPath, envLines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });

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
