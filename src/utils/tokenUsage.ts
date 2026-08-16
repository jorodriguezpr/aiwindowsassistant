/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

export interface TokenUsageEntry {
  timestamp: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  operation: string;
}

const MAX_ENTRIES = 10000;

function usageFile(): string {
  return path.join(config.dataDir, 'token-usage.json');
}

/** Mirrors AiAgentAssistant's LogAiTokenUsageSkill: data/token-usage.json */
export function logTokenUsage(entry: Omit<TokenUsageEntry, 'timestamp'>): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    let entries: TokenUsageEntry[] = [];
    const file = usageFile();
    if (fs.existsSync(file)) {
      try {
        entries = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!Array.isArray(entries)) entries = [];
      } catch {
        entries = [];
      }
    }
    entries.push({ timestamp: new Date().toISOString(), ...entry });
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  } catch {
    // Token logging must never fail the AI request (same policy as AiAgentAssistant)
  }
}

export function getUsageSummary(): { total: number; byProvider: Record<string, number>; entries: number } {
  try {
    const file = usageFile();
    if (!fs.existsSync(file)) return { total: 0, byProvider: {}, entries: 0 };
    const entries: TokenUsageEntry[] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const byProvider: Record<string, number> = {};
    let total = 0;
    for (const e of entries) {
      total += e.totalTokens || 0;
      byProvider[e.provider] = (byProvider[e.provider] || 0) + (e.totalTokens || 0);
    }
    return { total, byProvider, entries: entries.length };
  } catch {
    return { total: 0, byProvider: {}, entries: 0 };
  }
}
