# ASRP — Agent Science Research Platform

[English](README.md) | [中文](README.zh-CN.md) | **Deutsch**

> Wissenschaftliche Methodik in KI-Agenten-Workflows kodieren.

**ASRP** ist ein Open-Source-Framework für KI-gestützte kollaborative wissenschaftliche Forschung. Es bietet Werkzeuge, Protokolle und Benchmarks, um Mensch-Agenten-Forschungskooperationen **reproduzierbar, prüfbar und selbstkorrigierend** zu machen.

## Warum ASRP?

Im März 2026 produzierte ein einzelner Forscher mit Bachelor-Abschluss und zwei KI-Agenten 20 theoretische Physik-Papers in 16 Tagen. Einige wurden abgelehnt. Einige befinden sich im Review. Ein kritisches Experiment wurde während des Prozesses selbst korrigiert — als die Agenten entdeckten, dass sie eine falsche Definition verwendet hatten.

**Geschwindigkeit ohne Strenge ist Rauschen. ASRP fügt die Strenge hinzu.**

## Kernprinzipien

1. **Experimentelle Vorregistrierung** — Hypothesen vor der Durchführung registrieren. Kein nachträgliches Storytelling.
2. **Unabhängige Kreuzvalidierung** — Verschiedene Agenten müssen Ergebnisse reproduzieren, bevor sie in ein Paper eingehen.
3. **Prüfprotokolle** — Jede Entscheidung, jeder Datenpunkt, jede Fehlerkorrektur wird protokolliert.
4. **Token-Budgetverwaltung** — Das richtige Modell für die richtige Aufgabe.
5. **Trennung von Entdeckung und Verifikation** — Der Agent, der eine Hypothese aufstellt, ist nicht derjenige, der sie validiert.

## Agentenrollen

| Rolle | Aufgabe | Modellempfehlung |
|-------|---------|-----------------|
| **Theoretiker** | Hypothesengenerierung, theoretisches Denken, Paper-Schreiben | Claude Opus |
| **Ingenieur** | Code, Berechnung, Datenpipelines | Claude Sonnet |
| **Gutachter** | Unabhängige Begutachtung (nur Lesezugriff) | Claude Opus |
| **Bibliothekar** | Literaturrecherche, Referenzverwaltung | Gemini Flash |
| **IT-Doktor** | Systemüberwachung, Backups, Agenten-Lifecycle | Gemini Flash |

## Bereitstellung

- **Einzelrechner-Modus**: Alle Agenten auf einer Maschine (Standard)
- **Docker-Modus**: Jeder Agent in einem Container (für Teams)

Details siehe [`docs/architecture.md`](docs/architecture.md)

## Sicherheit

- ⚠️ **Keine API-Schlüssel oder Token im Repository**
- Alle Zugangsdaten über Umgebungsvariablen oder Konfigurationsdateien
- `asrp init` für die Ersteinrichtung

## Schnellstart

```bash
git clone https://github.com/JackZH26/agent-science-research-platform.git
cd agent-science-research-platform
export PATH="$PATH:$(pwd)/bin"
mkdir meine-forschung && cd meine-forschung
asrp init
asrp register
asrp status
```

Vollständige Anleitung: [`docs/quickstart.md`](docs/quickstart.md)

## Fallstudie

Siehe [`examples/portfolio/`](examples/portfolio/) — 20 Papers in 16 Tagen, mit vollständiger Fehleranalyse.

## Community

Tritte unserem Discord bei, um Forschung zu diskutieren und Hilfe zu erhalten:

👉 [**ASRP Discord beitreten**](https://discord.gg/DFmwBkDTB)

## Lizenz

Apache 2.0

## Autor

[JZIS — JZ Institute of Science](https://www.jzis.org/)
