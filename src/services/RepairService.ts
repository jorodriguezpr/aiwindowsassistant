/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Repair routines (1.5.0): named, fixed step lists for the classic Windows problems — internet,
 * printer, sound, search, Windows Update, system files, disk space, slow PC. The owner approves
 * the whole routine once (the approval shows every step); routines that change the system start
 * with a System Restore point when the admin helper is installed; the first failing step stops
 * the routine. Steps are this app's own tools, so nothing here is free-form.
 */

import type { ToolDefinition } from '../providers/AIProvider';
import type { ToolResult, ToolContext } from '../tools/AITools';
import { callElevated, helperState, HELPER_MISSING } from '../elevated/client';

interface Step {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  /** changes something (vs. only looks) */
  changes: boolean;
}
interface Routine {
  title: string;
  steps: Step[];
  /** take a restore point first (needs the admin helper) */
  restorePoint?: boolean;
}

const admin = (label: string, task: string, param?: string): Step => ({ label, tool: 'admin_task', args: param ? { task, param } : { task }, changes: true });
const CONNECTIVITY = "if (Test-NetConnection 1.1.1.1 -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue) { 'Internet: reachable' } else { 'Internet: NOT reachable' }; if (Resolve-DnsName microsoft.com -ErrorAction SilentlyContinue) { 'DNS: working' } else { 'DNS: NOT working' }";

export const ROUTINES: Record<string, Routine> = {
  internet: {
    title: 'Internet not working',
    steps: [
      { label: 'Check the connection and DNS', tool: 'execute_command', args: { command: CONNECTIVITY }, changes: false },
      { label: 'Flush the DNS cache', tool: 'execute_command', args: { command: 'ipconfig /flushdns' }, changes: true },
      { label: 'Renew the IP address', tool: 'execute_command', args: { command: 'ipconfig /renew' }, changes: true },
      { label: 'Check again', tool: 'execute_command', args: { command: CONNECTIVITY }, changes: false },
    ],
  },
  'network-reset': {
    title: 'Reset the network stack (when "internet" did not help) — needs a restart',
    restorePoint: true,
    steps: [admin('Reset Winsock, TCP/IP and DNS cache', 'network_reset')],
  },
  printer: {
    title: 'Printer stuck or not printing',
    steps: [admin('Clear stuck print jobs and restart the print spooler', 'clear_print_queue')],
  },
  sound: {
    title: 'No sound',
    steps: [admin('Restart the Windows audio services', 'restart_service', 'AudioEndpointBuilder'), admin('Make sure Windows Audio runs', 'restart_service', 'Audiosrv')],
  },
  search: {
    title: 'Windows search not finding things',
    steps: [admin('Restart Windows Search', 'restart_service', 'WSearch')],
  },
  'windows-update': {
    title: 'Windows Update failing',
    restorePoint: true,
    steps: [
      admin('Clear the Windows Update download cache and temp files', 'system_cleanup'),
      admin('Repair the component store (DISM)', 'dism_restorehealth'),
      admin('Repair system files (sfc)', 'sfc_scan'),
      { label: 'Look for updates again', tool: 'admin_task', args: { task: 'windows_update_scan' }, changes: false },
    ],
  },
  'system-files': {
    title: 'Repair Windows system files (crashes, odd errors)',
    restorePoint: true,
    steps: [admin('Repair the component store (DISM)', 'dism_restorehealth'), admin('Repair system files (sfc)', 'sfc_scan')],
  },
  'free-space': {
    title: 'Disk full',
    steps: [
      { label: 'Clean temp files and caches (safe targets)', tool: 'clean_up_disk', args: { targets: 'all-safe' }, changes: true },
      admin('Clean Windows temp and update caches', 'system_cleanup'),
    ],
  },
  'slow-pc': {
    title: 'PC is slow (diagnosis only, changes nothing)',
    steps: [
      { label: 'What uses the CPU', tool: 'list_processes', args: { sortBy: 'cpu' }, changes: false },
      { label: 'What uses the memory', tool: 'list_processes', args: { sortBy: 'memory' }, changes: false },
      { label: 'What starts with Windows', tool: 'get_startup_programs', args: {}, changes: false },
      { label: 'Health report', tool: 'health_report', args: {}, changes: false },
    ],
  },
};

const needsHelper = (r: Routine) => r.restorePoint || r.steps.some((s) => s.tool === 'admin_task');

/** For the approval message: every step, in order. null = no such routine. */
export function describeRoutine(name: string): { changes: boolean; text: string } | null {
  const r = ROUTINES[name.trim().toLowerCase()];
  if (!r) return null;
  const lines = [...(r.restorePoint ? ['0. Create a System Restore point'] : []), ...r.steps.map((s, i) => `${i + 1}. ${s.label}${s.changes ? '' : ' (look only)'}`)];
  return { changes: r.steps.some((s) => s.changes), text: `${r.title}\n${lines.join('\n')}` };
}

export function listRoutines(): string {
  return Object.entries(ROUTINES)
    .map(([k, r]) => `• ${k} — ${r.title}${needsHelper(r) ? ' (admin helper)' : ''}`)
    .join('\n');
}

export const REPAIR_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'run_repair',
    description:
      'Run a built-in repair routine for a common Windows problem; the user approves the whole routine once. Routines: ' +
      Object.entries(ROUTINES).map(([k, r]) => `${k} (${r.title})`).join('; '),
    parameters: { type: 'object', properties: { routine: { type: 'string', enum: Object.keys(ROUTINES) } }, required: ['routine'] },
  },
];

/** Runs the routine's steps (already approved as a whole by the gate). `exec` runs one tool. */
export async function executeRepairTool(args: Record<string, unknown>, ctx: ToolContext, exec: (name: string, args: Record<string, unknown>) => Promise<ToolResult>): Promise<ToolResult> {
  const name = String(args.routine || '').trim().toLowerCase();
  const r = ROUTINES[name];
  if (!r) return { success: false, error: `No repair routine "${name}". Routines:\n${listRoutines()}` };
  if (needsHelper(r) && !helperState().running) return { success: false, error: `"${name}" needs administrator rights. ${HELPER_MISSING}` };

  const log: string[] = [`🛠 ${r.title}`];
  const say = (line: string) => {
    log.push(line);
    ctx.onProgress?.(log.join('\n'));
  };
  if (r.restorePoint) {
    const rp = await callElevated('restore_point');
    say(rp.ok ? `✅ 0. ${rp.output}` : `⚠️ 0. No restore point (${rp.error}) — continuing`);
  }
  for (const [i, step] of r.steps.entries()) {
    const res = await exec(step.tool, step.args);
    const detail = String(res.output ?? res.stdout ?? res.error ?? '').trim().split(/\r?\n/).slice(0, 12).join('\n');
    say(`${res.success ? '✅' : '❌'} ${i + 1}. ${step.label}${detail ? `\n${detail}` : ''}`);
    if (!res.success && step.changes) {
      say(`Stopped at step ${i + 1}.${r.restorePoint ? ' A restore point was taken before the changes.' : ''}`);
      return { success: false, error: log.join('\n') };
    }
  }
  return { success: true, output: log.join('\n') };
}
