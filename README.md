# AiWindowsAssistant

A Telegram-controlled AI agent that runs from your Windows 11 system tray and delegates real
tasks on your PC — file operations, PowerShell commands, and full agentic coding work via a
headless [Claude Code](https://github.com/anthropics/claude-code) bridge — all from your phone.

Developer: **Jose Rodriguez Arroyo** — [jrpcone@gmail.com](mailto:jrpcone@gmail.com)
GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
Site: [microrepair.net](https://microrepair.net) — *Serving the Internet Community since 1999*

Sole contributor: Jose Rodriguez Arroyo.

---

## What it does

- **Telegram bot, tray app** — no console window, controllable entirely from your phone. Lives in
  the Windows system tray with pause/resume, a test-message button, and quick links to logs/config.
- **Two execution engines, switchable at runtime** (`/engine claude|ollama`):
  - **Claude Code** (default) — delegates to the real `claude` CLI headlessly, one resumable
    session per Telegram chat, with full agentic file/coding/shell capability.
  - **Local model loop** — a lightweight tool-calling agent against Anthropic, Ollama Cloud, or a
    local Ollama instance, for quick answers without spinning up a full Claude Code session.
- **Instant local fast-path** — common requests ("open notepad", "list C:\path", "system info")
  are pattern-matched and run immediately with zero AI round-trip.
- **Telegram approval gate for destructive actions** — both engines route anything
  destructive-looking (deleting files, stopping processes, risky shell commands, edits reaching
  outside the configured workspace) through an inline Approve/Deny prompt in Telegram before it
  runs, with a 5-minute timeout.
- **Windows-native autostart** — one flag registers a hidden launcher in the current user's
  registry `Run` key; no service install, no elevation required.
- **Token usage tracking** and structured logging with automatic secret redaction.

## Requirements

- Windows 11
- [Node.js](https://nodejs.org/) 18+
- A Telegram bot token — create one via [@BotFather](https://t.me/BotFather)
- At least one AI backend:
  - [Claude Code CLI](https://github.com/anthropics/claude-code) (`npm install -g @anthropic-ai/claude-code`, then `claude login`) — recommended, needed for the default engine
  - and/or an Anthropic API key, an Ollama Cloud API key, or a local [Ollama](https://ollama.com/) install, for the local-model engine

## Installation

### Quick install (Windows, recommended)

One PowerShell command on a fresh machine — installs Git and Node.js if missing (via `winget`),
clones the repo, installs npm dependencies and the Claude Code CLI, scaffolds `.env`, and builds:

```powershell
irm https://raw.githubusercontent.com/jorodriguezpr/aiwindowsassistant/main/scripts/install.ps1 | iex
```

Already have the repo cloned? Run the same script from inside it instead:

```powershell
.\scripts\install.ps1
```

### Manual install

```powershell
git clone https://github.com/jorodriguezpr/aiwindowsassistant.git
cd aiwindowsassistant
npm install
copy .env.example .env
# edit .env — see Configuration below
npm run build
npm start
```

On first run, message your bot with `/start` — it replies with your numeric Telegram chat ID.
Add that ID to `TELEGRAM_ALLOWED_USERS` in `.env` and restart. **The bot will not respond to
anything except `/start` until an allowed user is configured** — this is deliberate (see
Security notes).

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your bot's token from BotFather |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated chat IDs allowed to use the bot — **required**, empty means the bot only answers `/start` |
| `AI_PROVIDER` | `anthropic` \| `ollama-cloud` \| `ollama` — backend for the local-model engine |
| `ANTHROPIC_API_KEY` / `OLLAMA_CLOUD_API_KEY` | API key for the selected local-model provider |
| `CLAUDE_CODE_PATH` | Path to the `claude` executable — auto-detected from `PATH` if empty |
| `CLAUDE_WORKSPACE` | Folder Claude Code operates in when you delegate a task |
| `CLAUDE_PERMISSION_MODE` | Must be `bypassPermissions` for the Claude Code engine to actually execute tool calls headlessly — this app's own Telegram approval hook is the real safety gate, not Claude Code's built-in prompts (which have no terminal to prompt through in headless mode) |
| `AUTO_START` | `true` to register the Windows autostart launcher on boot |

Full list with defaults: see [`.env.example`](.env.example).

## Usage

| Command | Does |
|---|---|
| `/task <text>` | Delegate a task, using the default engine |
| `/claude <prompt>` | Send straight to Claude Code (no history, per-chat session resumes) |
| `/execute <cmd>` | Run a PowerShell command directly |
| `/ai <text>` | Force this one request through the local-model engine |
| `/engine [claude\|ollama]` | Show/switch the default engine |
| `/provider [anthropic\|ollama-cloud\|ollama]` | Show/switch the local-model provider |
| `/aimodel [model]` | Show/change the local model |
| `/status` | Bot, engine, provider, Claude CLI, and queue status |
| `/clear` | Reset conversation + Claude Code session for this chat |
| `/cancel` | Cancel the currently running task |
| `/pause` / `/resume` | Stop/resume processing new messages |

Or just type naturally — fast local actions run instantly, anything else is delegated.

## Security notes

- **Fail-closed access control**: an empty/misconfigured `TELEGRAM_ALLOWED_USERS` disables the
  bot rather than opening it to anyone who finds it.
- **Destructive-action approval**: both engines require an explicit Telegram approve before
  running anything destructive-looking. For the Claude Code engine specifically, this is enforced
  via a `PreToolUse` hook (`scripts/claude-approval-hook.js`) that gates `Bash`, `Write`, `Edit`,
  and `NotebookEdit` calls — it does **not** currently gate `Read`/`Glob`/`Grep`/`WebFetch`/
  `WebSearch`/subagent (`Task`) calls, which run unrestricted once `bypassPermissions` is set. This
  is an accepted tradeoff for a single-owner tool, not an oversight — know it before relying on it.
- **No secrets in logs**: an allowlist-based log serializer strips anything shaped like an API key
  or auth header before it can reach the log files, even on request failures.
- **This app grants real control of your PC** to anyone with access to the allowed Telegram
  account(s) — treat the bot token and your Telegram account security accordingly.

## Limitations

This is a deliberately small, single-owner tool, not a full platform. Known gaps:

- **Telegram only** — no Discord/WhatsApp/web chat gateways.
- **No email, PDF generation, or scheduled/recurring automation** (no cron-like task scheduler).
- **No task persistence across restarts** — an in-progress task is lost if the app restarts;
  conversation history and Claude Code sessions are in-memory per chat.
- **No built-in sysadmin tool library** beyond raw PowerShell via `execute_command` — the AI
  composes commands itself rather than choosing from curated, structured tools.
- **No cross-task learning/knowledge base** — each conversation starts fresh (aside from Claude
  Code's own per-chat session resume).
- **No multi-step planning engine** — the local-model engine runs a flat tool-calling loop, not a
  dependency-graph/parallel plan executor; Claude Code's own planning is used as-is.
- **Windows-only** — PowerShell-based tooling, registry-based autostart, Windows path conventions.
- **No web/API interface** — control is exclusively through Telegram.

## Development

```powershell
npm run dev      # ts-node, no build step
npm run build     # tsc + regenerate the tray icon
npm start         # run the compiled dist/
```

## License

[MIT](LICENSE) — Copyright (c) 2026 Jose Rodriguez Arroyo
