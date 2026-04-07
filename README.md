# ASRP Desktop

Desktop application for the [Agent Science Research Platform](https://asrp.jzis.org) — AI-powered collaborative scientific research.

## What is ASRP?

ASRP Desktop provides a local research environment with 3 AI agents that work together on your scientific research:

- 🧠 **Albert** (Theorist) — Hypotheses, experiment design, literature search
- ⚙️ **Wall-E** (Engineer) — Code, simulations, numerical experiments, result validation
- 🤖 **Aria** (Assistant) — Task coordination, workflow management, system monitoring

Each agent connects to your Discord server via [OpenClaw](https://openclaw.ai) and can be interacted with in real-time.

## Features

- **Setup Wizard** — Guided configuration: API keys, OpenClaw, Discord bots
- **Dashboard** — Agent status, research progress, gateway monitoring
- **Agent Management** — SOUL editor, model switching, start/stop control
- **Research Registry** — Pre-register hypotheses with falsification criteria
- **Paper Pipeline** — 6-stage workflow from draft to submission
- **File Manager** — Workspace browser with preview and edit
- **Assistant Chat** — Cmd/Ctrl+J floating panel (cloud or local AI)
- **Auto-Update** — Checks for updates on startup, one-click install

## Quick Start

1. Download from [Releases](https://github.com/JackZH26/ASRP-JZIS/releases/latest)
2. Install and open ASRP Desktop
3. Follow the 5-step setup wizard
4. Start researching with your AI team

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run dist          # All platforms
npm run dist:mac      # macOS (.dmg + .zip)
npm run dist:win      # Windows (.exe)
npm run dist:linux    # Linux (.AppImage)
```

## Architecture

- TypeScript main process + HTML/CSS/JS renderer
- OpenClaw gateway for AI agent runtime (3 independent instances)
- SQLite for local auth, JWT for sessions
- Discord integration via OpenClaw channels
- Encrypted API key storage (OS-level encryption)

## License

Apache-2.0 · Copyright © 2026 JZ Institute of Science
