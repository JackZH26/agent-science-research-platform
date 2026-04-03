# ASRP Desktop

GUI application for the [Agent Science Research Platform](https://github.com/JackZH26/agent-science-research-platform).

## Features

- **Login/Register** — Local SQLite auth with JWT
- **Setup Wizard** — 4-step guided configuration
- **Dashboard** — Real-time agent status, token usage, research progress
- **Assistant Chat** — Cmd/Ctrl+J floating panel, local (Gemma 27B) or cloud model
- **Agent Management** — SOUL editor, model switching, logs, restart
- **File Manager** — Directory tree, preview, edit, search
- **Paper Manager** — 6-stage pipeline, version diff, review records, submission tracking
- **Experiments** — Registration, filtering, audit trail with CSV export
- **Ollama Integration** — Local Gemma 27B for zero-cost assistant queries

## Development

```bash
cd desktop/
npm install
npm run dev
```

## Build

```bash
npm run dist          # All platforms
npm run dist:win      # Windows (.exe)
npm run dist:mac      # macOS (.dmg)
npm run dist:linux    # Linux (.AppImage)
```

## Tech Stack

- TypeScript (main process)
- HTML/CSS/JS (renderer, Mint Apple design system)
- SQLite (auth), JWT (sessions)
- Ollama (local AI model)

## License

Apache-2.0
