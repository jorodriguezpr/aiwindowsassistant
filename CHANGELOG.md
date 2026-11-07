# Changelog

All notable changes to AiWindowsAssistant.

## 1.7.1 — 2026-11-07

### Fixed
- **`/pause` did not really pause the bot.** Reported by [@mattabate](https://github.com/mattabate).
  - *Problem:* `/pause` replied "I will ignore new messages until /resume", but only plain text,
    `/task`, `/ai` and photos checked the pause. While the bot was paused, from Telegram or the tray:
    - `/execute` still ran PowerShell commands;
    - `/claude`, `/screenshot`, `/cleanup`, `/apps`, `/fix` and `/admin` still started work;
    - `/settings`, `/health`, `/schedule` and `/alerts check` still acted;
    - Approve buttons still approved actions.
  - *Fix:* the pause is now checked once, in the Telegram middleware, for every update: commands,
    messages, photos, files and buttons. Text typed in the Ctrl+Alt+Space chat window goes through
    the same check. While paused:
    - only `/resume`, `/pause`, `/status`, `/help`, `/start`, `/tasks` and `/cancel` are answered;
      they only report or stop work;
    - everything else gets "⏸ Bot is paused";
    - Approve and "approve all for 10 min" are refused in Telegram, the chat window and Windows
      notifications, while Deny still works;
    - an approval that was asked before the pause waits and then times out as denied.
  - Work that was already running keeps going until it finishes or you `/cancel` it. Tasks created
    with `/schedule` run from Windows Task Scheduler and are not affected by the pause.
  - New tests: `tests/pause18.test.js`.

## 1.7.0 — 2026-11-01
- `/tasks` shows what the assistant is doing right now: running, waiting for approval, queued.
- `/cancel` stops your running and queued work, including child processes. `/cancel all` also stops
  delegated work, and `/cancel <n>` stops one item.

## 1.6.0 — 2026-11-01
- Optional Ollama Cloud engine next to Claude Code (`/engine`, `/workers`).
- Talking avatar in the chat window.

## 1.5.0 — 2026-11-01
- The assistant's tools are offered to Claude Code over MCP.
- Operating apps through UI Automation, repair routines (`/fix`) and proactive alerts.
- Ctrl+Alt+Space chat window at the PC.
- Windows installer.

## 1.4.0 — 2026-11-01
- Optional administrator helper.
- Settings launcher, screenshots and photo input, disk cleanup, weekly health report (PDF), winget
  app updates.
- Windows notifications with Approve/Deny buttons.

## 1.3.0 — 2026-10-31
- Security release: one approval policy for every tool call, and a fail-closed Telegram allow-list.
