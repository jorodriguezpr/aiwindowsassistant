/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Which engine does the work (1.6.0):
 *   claude    — the Claude Code CLI on this PC (needs it installed and signed in)
 *   assistant — this app's own engine: the AI_PROVIDER model (e.g. Ollama Cloud) with this app's
 *               tools, policy and approvals — no Claude Code needed
 * Two choices: `tasks` (your Telegram / chat-window messages and /task) and `workers` (the
 * BJavaDecompiler delegations and Fleet Guardian escalations this PC processes). Defaults come
 * from .env (DEFAULT_ENGINE / WORKER_ENGINE); /engine and /workers change them and the change is
 * kept in data/engine.json across restarts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

export type Engine = 'claude' | 'assistant';

/** 'ollama' and 'local' are accepted as older names of the assistant engine. */
export function parseEngine(v: string | undefined, fallback: Engine): Engine {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'claude' || s === 'claude-code') return 'claude';
  if (s === 'assistant' || s === 'ollama' || s === 'ollama-cloud' || s === 'local') return 'assistant';
  return fallback;
}

const FILE = () => path.join(config.dataDir, 'engine.json');

function read(): Partial<Record<'tasks' | 'workers', Engine>> {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return {};
  }
}

export function getEngine(kind: 'tasks' | 'workers'): Engine {
  const saved = read()[kind];
  return saved ? parseEngine(saved, config.engines[kind]) : config.engines[kind];
}

export function setEngine(kind: 'tasks' | 'workers', engine: Engine): void {
  const all = { ...read(), [kind]: engine };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(all, null, 1));
}

export function engineLabel(e: Engine): string {
  return e === 'claude' ? 'Claude Code' : `the assistant engine (${config.ai.provider}${config.ai.model ? ' / ' + config.ai.model : ''})`;
}
