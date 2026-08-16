/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Thin wrapper around schtasks.exe. Deliberately a constrained subset (daily/weekly/hourly),
 * not a full cron parser — the OS only needs to know *when* to fire; scheduled-runner.ts (invoked
 * by the registered task) looks up *what* to do from ScheduleStore by id. Registering real
 * Windows Scheduled Tasks (rather than an in-process timer) is what makes scheduled runs survive
 * the tray app not being open — that's the whole point of pairing this with item 2's persistence.
 */
import { execSync } from 'child_process';
import * as path from 'path';
import { config } from '../config';

export type ScheduleKind = 'daily' | 'weekly' | 'hourly';

export interface ScheduleSpec {
  kind: ScheduleKind;
  time?: string; // HH:mm, required for daily/weekly
  day?: string; // MON..SUN, required for weekly
}

const WEEKDAYS = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parses "daily HH:mm" | "weekly <DAY> HH:mm" | "hourly". Returns null on anything else — the
 * caller is responsible for reporting a usage error rather than guessing. */
export function parseScheduleDesc(desc: string): ScheduleSpec | null {
  const parts = desc.trim().split(/\s+/);
  const kind = parts[0]?.toLowerCase();

  if (kind === 'hourly' && parts.length === 1) return { kind: 'hourly' };

  if (kind === 'daily' && parts.length === 2 && TIME_RE.test(parts[1])) {
    return { kind: 'daily', time: parts[1] };
  }

  if (kind === 'weekly' && parts.length === 3) {
    const day = parts[1].toUpperCase();
    if (WEEKDAYS.has(day) && TIME_RE.test(parts[2])) {
      return { kind: 'weekly', day, time: parts[2] };
    }
  }

  return null;
}

export function taskName(id: number): string {
  return `AiWindowsAssistant-${id}`;
}

function runnerCommand(id: number): string {
  const runnerPath = path.join(config.projectRoot, 'dist', 'scheduled-runner.js');
  // Nested-quote escaping matches the established pattern in utils/autostart.ts.
  return `node \\"${runnerPath}\\" ${id}`;
}

export function registerWindowsTask(id: number, spec: ScheduleSpec): void {
  const name = taskName(id);
  const tr = runnerCommand(id);
  let scArgs: string;
  if (spec.kind === 'hourly') {
    scArgs = '/sc hourly';
  } else if (spec.kind === 'daily') {
    scArgs = `/sc daily /st ${spec.time}`;
  } else {
    scArgs = `/sc weekly /d ${spec.day} /st ${spec.time}`;
  }
  execSync(`schtasks /create /tn "${name}" /tr "${tr}" ${scArgs} /f`, { stdio: 'pipe' });
}

export function unregisterWindowsTask(id: number): void {
  try {
    execSync(`schtasks /delete /tn "${taskName(id)}" /f`, { stdio: 'pipe' });
  } catch {
    // already gone — fine
  }
}

export function windowsTaskExists(id: number): boolean {
  try {
    execSync(`schtasks /query /tn "${taskName(id)}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
