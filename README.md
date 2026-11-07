# AiWindowsAssistant

A Telegram-controlled AI agent that runs from your Windows 11 system tray and delegates real
tasks on your PC — file operations, PowerShell commands, and full agentic coding work via a
headless [Claude Code](https://github.com/anthropics/claude-code) bridge — all from your phone.

Developer: **Jose Rodriguez Arroyo** — [jrpcone@gmail.com](mailto:jrpcone@gmail.com)
GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
Site: [microrepair.net](https://microrepair.net) — *Serving the Internet Community since 1999*

Contributors:  
11/6/2026 - @mattabate  Pause Issue - /pause did not really pause the bot - Fixed v1.7.1

---

## What it does

- **Telegram bot, tray app** — no console window, controllable entirely from your phone. Lives in
  the Windows system tray with pause/resume, a test-message button, a "Start with Windows"
  checkbox, and quick links to logs/config.
- **Two execution engines, switchable at runtime** (`/engine claude|assistant`, `/workers claude|assistant`):
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
- **Windows-native autostart** — toggle from the tray menu, or set the `AUTO_START` flag; either
  registers a hidden launcher in the current user's registry `Run` key, no service install or
  elevation required.
- **Persists across restarts** — conversation history, Claude Code sessions, and parked
  (iteration-cap) state are stored in a local SQLite database, not just in memory.
- **Curated sysadmin tools** for the local-model engine — disk usage, processes, services,
  event-log errors, network info, firewall rules, scheduled tasks, installed software, startup
  programs — structured output instead of composing raw PowerShell for common admin checks.
- **Send-only email and PDF generation** — `send_email` and `generate_pdf` tools (no inbox
  reading).
- **Recurring automation via real Windows Task Scheduler** (`/schedule`) — runs even when the app
  isn't open; always unattended, so destructive actions are skipped rather than approved.
- **Cross-task knowledge base** (`/remember`, `/notes`) — durable notes shared by both engines,
  independent of Claude Code's own separate per-project `MEMORY.md` continuity.
- **Token usage tracking** and structured logging with automatic secret redaction.

## Requirements

- Windows 11
- [Node.js](https://nodejs.org/) 18+
- A Telegram bot token — create one via [@BotFather](https://t.me/BotFather)
- At least one AI backend:
  - [Claude Code CLI](https://github.com/anthropics/claude-code) (`npm install -g @anthropic-ai/claude-code`, then `claude login`) — recommended, needed for the default engine
  - and/or an Anthropic API key, an Ollama Cloud API key, or a local [Ollama](https://ollama.com/) install, for the local-model engine

## Installation

### Windows installer (recommended)

Download **`AiWindowsAssistant-Setup-<version>.exe`** from the
[latest release](https://github.com/jorodriguezpr/aiwindowsassistant/releases/latest) and run it.
No administrator rights and no Node.js needed — it installs a single self-contained program for
your user (`%LOCALAPPDATA%\Programs\AiWindowsAssistant`) and asks for:

1. your Telegram bot token (from @BotFather) and, if you know it, your chat ID;
2. the local AI service (Ollama Cloud, Anthropic API or Ollama on the PC) and its key;
3. the folder the assistant may work in.

Options: start with Windows, desktop shortcut, and the **administrator helper** (one UAC prompt).
Your secrets are encrypted with Windows (DPAPI) right after installing. Upgrading keeps your
settings; uninstalling (Settings → Apps) asks whether to keep your settings and history.

The program is not code-signed yet: Windows SmartScreen may show "Windows protected your PC" —
choose *More info → Run anyway*.

For the Claude Code engine, install Claude Code separately and run `claude` once to sign in.

Building the installer yourself: `npm run release` (needs Inno Setup 6:
`winget install JRSoftware.InnoSetup`) → `pkg-dist/AiWindowsAssistant-Setup-<version>.exe`.

### Quick install from source (developers)

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
| `DOCUMENTS_DIR` | Where `generate_pdf` writes files. Defaults to `Documents\AiWindowsAssistant` |
| `EMAIL_SMTP_HOST` / `_PORT` / `_SECURE` / `_USER` / `_PASS` / `EMAIL_FROM` | SMTP config for `send_email` — leave `EMAIL_SMTP_HOST` empty to disable the tool entirely (send-only, no inbox reading) |
| `TRUSTED_COMMANDS` | Comma-separated commands that run without approval, e.g. `git,npm,node` (their dangerous forms still ask) |
| `SENSITIVE_PATHS` | Extra folders/files no command or tool may ever touch (comma-separated) |

Full list with defaults: see [`.env.example`](.env.example).

## Usage

| Command | Does |
|---|---|
| `/task <text>` | Delegate a task, using the default engine |
| `/claude <prompt>` | Send straight to Claude Code (no history, per-chat session resumes) |
| `/execute <cmd>` | Run a PowerShell command directly |
| `/ai <text>` | Force this one request through the local-model engine |
| `/engine [claude|assistant]` · `/workers [claude|assistant]` | Claude Code (default) or the assistant engine (e.g. Ollama Cloud) for your messages / for delegated work |
| `/provider [anthropic\|ollama-cloud\|ollama]` | Show/switch the local-model provider |
| `/aimodel [model]` | Show/change the local model |
| `/status` | Bot, engine, provider, Claude CLI, and queue status |
| `/doctor` | Check everything works: settings, secrets, Claude Code, approval gate, AI provider, email, database |
| `/screenshot` | Screenshot of the PC's screen(s) — or send a **photo** (e.g. of an error message) and ask about it |
| `/settings <page>` | Open a Windows Settings page: bluetooth, display, wifi, windows update, default apps… |
| `/cleanup` · `/cleanup run all-safe` | What can be cleaned (temp, browser/npm/pip caches, crash dumps, old installers, Windows Update cache…), then clean it (asks first) |
| `/health` · `/health weekly on\|off` | PC health report as a PDF (disks, updates, Defender, firewall, restarts, errors, memory, BitLocker) — once, or every week automatically |
| `/apps` · `/apps search\|install\|upgrade <app>` · `/apps upgrade all` | Apps with winget: what needs updating, search, install, update (install/update ask first) |
| `/admin` · `/admin <task> [param]` | Administrator jobs through the helper: Windows updates, BitLocker, Defender scan, restore point, restart a service, hibernation/page file, system clean-up, sfc |
| `/clear` | Reset conversation + Claude Code session for this chat |
| `/tasks` | What the AI is doing right now: each running task with its engine, time and current step, approvals waiting for you, queued work |
| `/cancel` · `/cancel all` · `/cancel <n>` | Stop your running and queued work — or everything (workers too) — or one item from `/tasks`. Also by saying "cancel" / "stop" / "cancela". Stopping kills the whole process tree (Claude Code and every command it started, a running PowerShell command and its children); approvals still waiting are withdrawn. An administrator job already running in the helper finishes on its own. |
| `/pause` / `/resume` | Pause/resume the bot — while paused it acts on nothing (no commands, messages, photos or Approve, from Telegram, the chat window or notifications); only `/status`, `/tasks`, `/cancel`, `/help` and Deny still work |
| `/remember <fact>` | Save a durable note (both engines see it) |
| `/notes [search]` | List/search saved notes |
| `/schedule add <name> <daily HH:mm\|weekly <day> HH:mm\|hourly> <prompt>` | Register a recurring task via Windows Task Scheduler |
| `/schedule list` / `/schedule remove <id>` | Manage your scheduled tasks |

Or just type naturally — fast local actions run instantly, anything else is delegated.

| `/fix` · `/fix <routine>` | Repair routines: internet, network-reset, printer, sound, search, windows-update, system-files, free-space, slow-pc — approved once as a whole, restore point first when they change the system |
| `/alerts` · `/alerts on\|off\|check\|reset` | Proactive alerts (see below) |

Plain sentences work too, instantly and without AI: "open bluetooth settings", "screenshot",
"free up space", "health check", "install vlc", "update all apps", "check for windows updates",
"fix my printer", "fix the internet", "what windows are open".

### Chat window at the PC, with a talking avatar

**Ctrl+Alt+Space** (`CHAT_HOTKEY`) or the tray menu opens a small window with the same
conversation as Telegram: type or 🎤 speak, approve with the buttons, everything the bot says to
you appears in both places. It is a loopback-only page (127.0.0.1) opened through a secret
per-run link; nothing is reachable from the network.

In the Windows installer / release builds the window shows the **SysAiBrain avatar**
([sysaibrain.com](https://sysaibrain.com)): it reads the answers aloud with moving lips, and
**🎙 Conversation** makes it hands-free — it listens, you talk, it answers aloud, and you can
approve or deny by voice ("approve" / "deny", "aprueba" / "niega"). Voice and listening use the
browser's built-in speech engines; 🔊 turns the voice off, 🧑 hides the avatar. The avatar is
commercial SysAiBrain software, licensed **only for use inside AiWindowsAssistant**
([SYSAIBRAIN-AVATAR-LICENSE.txt](SYSAIBRAIN-AVATAR-LICENSE.txt)) and shipped only as an encrypted
binary inside the installer / release `.exe` — not covered by this project's MIT license and not
part of this source code (see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)). Builds from source
have the window without it.

### Claude Code or Ollama Cloud (1.6.0)

By default **Claude Code** does the work. Optionally, the assistant's **own engine** — the
`AI_PROVIDER` model (e.g. **Ollama Cloud**) with this app's tools, policy and approvals — can do it
instead, so Claude Code isn't needed:

| | Setting | Switch at runtime |
|---|---|---|
| Your messages and `/task` | `DEFAULT_ENGINE=claude\|assistant` | `/engine claude` · `/engine assistant` |
| BJavaDecompiler delegations + Fleet Guardian escalations | `WORKER_ENGINE=claude\|assistant` | `/workers claude` · `/workers assistant` |

The choice is kept across restarts; the installer has an (unchecked) option for it. On the
assistant engine, BJavaDecompiler prompts are answered directly by the model (pure text, no
tools) and escalations stay read-only (only looking tools and read-only commands, never asking).

### Both engines use the same tools (MCP)

Claude Code (the default engine) now gets this app's own tools — Settings, screenshots, apps,
admin jobs, clean-up, health, UI Automation, repair routines, sysadmin, email, PDF — as MCP tools
(`src/mcp/McpServer.ts`, started by Claude Code itself). Every call goes back through the
running app's gate: the same policy and the same approvals as everything else.

### Operating apps (UI Automation)

The assistant can see and use the apps on screen through Windows' accessibility tree:
`ui_list_windows`, `ui_inspect` (numbered list of the buttons, menus and fields of a window),
`ui_click`, `ui_type`, `ui_keys`, `ui_window` (focus, minimize, maximize, snap left/right, close).
Looking runs freely; clicking/typing asks — with **"Approve all here for 10 min"** for that one
window, so a multi-step task doesn't need a tap per click. Closing a window always asks.

### Proactive alerts

Every 10 minutes (`ALERT_INTERVAL_MINUTES`), without AI: system drive almost full, Microsoft
Defender detections, unexpected shutdowns, a disk reporting a problem, a restart pending for days,
and **new** programs starting with Windows, new automatic services or new scheduled tasks — the
usual footprints of unwanted software (compared by name with a baseline taken on the first run,
so app updates don't count). Sent to Telegram and as a Windows notification, at most once a day
per condition. `/alerts reset` accepts what is installed now; `ALERTS=false` turns them off.

### Windows notifications

Approval requests also appear as a Windows notification with **Approve / Deny** buttons — answer
at the PC or in Telegram, the first answer wins and the other is updated. Tasks that run longer
than `TOAST_LONG_TASK_SECONDS` (60) end with a notification. Nothing to install: the app
registers its name and an `aiwa:` link type for your user on start. Off: `TOAST_NOTIFICATIONS=false`.

### Administrator helper (optional)

The assistant runs as a normal user, so Windows updates, BitLocker, restore points, services and
system clean-up need administrator rights. Install the helper **once** from an administrator
PowerShell (`npm run install-helper`, or `AiWindowsAssistant.exe --install-helper`); remove it with
`uninstall-helper`. It starts at every logon with highest privileges, without UAC prompts.

- It only runs the fixed jobs in `src/elevated/ops.ts`, with validated parameters (service names
  from a list, a page-file size range, a winget package id) — never arbitrary commands.
- Its code is copied to `%ProgramData%\AiWindowsAssistant\helper`, which only administrators can
  change: starting code from the user-writable project folder as administrator would let any
  program running as you edit it and become administrator. **After updating the assistant, run
  the install again** (`/doctor` and `/admin` say when the helper is outdated).
- Jobs that change the system (installing updates or apps, page file, services, clean-up, sfc)
  still ask for your approval first; status checks, Defender scans and restore points don't.

## Security notes

- **Fail-closed access control**: an empty/misconfigured `TELEGRAM_ALLOWED_USERS` disables the
  bot rather than opening it to anyone who finds it.
- **Commands need approval unless they are known to be read-only** (since 1.3.0, both engines —
  `src/security/CommandPolicy.ts`). A command runs immediately only when every command in it
  (pipelines, `;`, `&&`, script blocks, `$( )`) is read-only: `Get-*`, `Test-*`, `Select-*`,
  `dir`, `ipconfig`, `git status`/`log`/`diff`, `ls`, `cat`, `grep`… Anything else — deleting or
  overwriting a file, downloads, `iex`, scheduled tasks, registry writes, .NET method calls, file
  redirection (`>`), running scripts or programs — asks for **Approve/Deny in Telegram** with the
  reason. Until 1.2.0 it was the other way round: a list of ~20 "dangerous" patterns, and
  everything not on it (e.g. `Remove-Item file.txt`, `Set-Content`, `iex (iwr …)`) ran unasked.
  - `TRUSTED_COMMANDS=git,npm,node` skips approval for tools you use all day; their dangerous
    forms (`git push --force`, `git reset --hard`, `npm publish`, recursive deletes…) still ask.
  - Writes are free inside `CLAUDE_WORKSPACE` (and `DOCUMENTS_DIR` for the local engine) and ask
    outside it.
- **Blocked outright, no Approve button**: credentials and keys (`~/.ssh`, `~/.aws`, browser saved
  passwords and cookies, Windows password hives, Credential Manager/DPAPI keys, `.pfx`/`.kdbx`/
  keystores, `.git-credentials`, `.npmrc`, Claude Code's login), this app's own `.env` and `data/`,
  anything in `SENSITIVE_PATHS`, plus encoded PowerShell (`-EncodedCommand`) and deleting restore
  points/backups (`vssadmin delete shadows`, `wbadmin delete`). For the Claude Code engine the
  `PreToolUse` hook also covers `Read`/`Glob`/`Grep`, so they can't read those locations either.
  `WebFetch`/`WebSearch`/subagents are not gated.
- **Approval gate token**: the loopback approval server only accepts requests carrying a random
  per-run token that only the hook it launched knows.
- **Secrets encrypted at rest**: `AiWindowsAssistant.exe --protect-secrets` (or
  `npm run protect-secrets`) encrypts the secrets in `.env` with Windows DPAPI for your user
  (`dpapi:…` values) — useless to another account or another PC. Plain values keep working, with
  a warning. Commands the assistant runs (and Claude Code) no longer inherit any of these secrets.
- **`/doctor`** checks everything at once: settings, secrets, Claude Code CLI, that the approval
  gate refuses requests without its token, the command policy, the AI provider, email login,
  folders, database. Tests: `npm test`.
- **No secrets in logs**: an allowlist-based log serializer strips anything shaped like an API key
  or auth header before it can reach the log files, even on request failures.
- **Scheduled tasks always run unattended**: a Task Scheduler-fired run has no live Telegram
  channel to approve anything through, so destructive tool calls are automatically denied rather
  than blocking forever or silently auto-approving. `/schedule` is meant for read-only/reporting
  prompts, not tasks that need a human in the loop.
- **This app grants real control of your PC** to anyone with access to the allowed Telegram
  account(s) — treat the bot token and your Telegram account security accordingly.

## Limitations

This is a deliberately small, single-owner tool, not a full platform. Known gaps:

- **Telegram only** — no Discord/WhatsApp/web chat gateways.
- **Email is send-only** — no inbox reading/monitoring.
- **The sysadmin tool library is curated (~10 tools)**, not exhaustive — the AI still falls back to
  raw PowerShell via `execute_command` for anything not covered. Since 1.5.0 both engines use
  this library (the Claude Code engine through the built-in MCP server).
- **No multi-step planning engine** — the local-model engine runs a flat tool-calling loop, not a
  dependency-graph/parallel plan executor; Claude Code's own planning is used as-is.
- **The knowledge base (`/remember`, `/notes`) is a flat note store**, not the original's
  auto-learning-from-successful-runs machinery — saving a note is explicit (the AI or the user
  choosing to), not automatic pattern extraction.
- **Windows-only** — PowerShell-based tooling, registry-based autostart, Windows path conventions.
- **No web/API interface** — control is exclusively through Telegram.

## Development

```powershell
npm run dev      # ts-node, no build step
npm run build     # tsc + regenerate the tray icon
npm start         # run the compiled dist/
```

## Changes

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## License

[MIT](LICENSE) — Copyright (c) 2026 Jose Rodriguez Arroyo
