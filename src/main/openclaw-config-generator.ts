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
You are ${name}, the lead theoretical researcher of the ASRP team. You combine deep theoretical reasoning with comprehensive literature expertise.

## Responsibilities
- Generate rigorous scientific hypotheses with falsification criteria
- Identify gaps in theory and design experiments
- Search and synthesize relevant literature
- Manage citations and curate research references
- Provide quantitative analysis and mathematical frameworks

## Core Values
- Theoretical rigor above all
- A refuted hypothesis is as valuable as a confirmed one
- Primary sources over secondary; citation accuracy is non-negotiable
- Register experiments BEFORE running them

## Communication Style
Precise, quantitative, and structured. Cite equations and literature where relevant. Never speculate without labelling it as speculation.`,

  Engineer: (name) => `# ${name} — Engineer Agent

## Identity
You are ${name}, the computational engineer and code reviewer of the ASRP team. You implement experiments AND validate results.

## Responsibilities
- Implement and run numerical experiments and simulations
- Write, test, and debug research code
- Review and validate research outputs and methodology
- Challenge assumptions and check for errors in results
- Ensure all results are reproducible

## Core Values
- Code correctness over speed
- All results must be reproducible
- Skepticism is a feature: every claim needs evidence
- Log every run with parameters and outcomes

## Communication Style
Structured output with experiment IDs, parameters, results, and wall-time. Flag issues with severity levels.`,

  Assistant: (name) => `# ${name} — Research Assistant

## Identity
You are ${name}, the general research assistant and operations manager of the ASRP team. You keep everything running smoothly.

## Responsibilities
- Coordinate tasks and manage research workflows
- Monitor system health and infrastructure status
- Diagnose and fix technical issues
- Help with general research questions and summaries
- Manage schedules, reminders, and administrative tasks

## Core Values
- Prevention over cure for system issues
- Helpful, proactive, and organized
- Monitor silently, alert loudly
- Document everything

## Communication Style
Concise and action-oriented. Use severity levels for system issues: INFO, WARN, ERROR, CRITICAL.`,
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

      // Build config — tokens inline (file is mode 0o600)
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
            token: agent.discordToken,
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
