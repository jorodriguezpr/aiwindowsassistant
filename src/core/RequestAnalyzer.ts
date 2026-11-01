/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Local fast path — port of AiAgentAssistant's RequestAnalyzer concept.
 * Recognizes common requests with pattern matching and executes them directly,
 * skipping the full AI loop (the "local AI" hybrid approach).
 */

import { findSettingsPage } from '../tools/WindowsTools';

export interface LocalIntent {
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

const PROGRAM_ALIASES: Record<string, string> = {
  code: 'code',
  vscode: 'code',
  notepad: 'notepad',
  calculator: 'calc',
  calc: 'calc',
  explorer: 'explorer',
  'task manager': 'taskmgr',
  taskmgr: 'taskmgr',
  'control panel': 'control',
  terminal: 'wt',
  'windows terminal': 'wt',
};

export class RequestAnalyzer {
  /**
   * Returns a LocalIntent if the text matches a known local pattern, else null.
   * Keep this conservative — anything ambiguous should fall through to the AI loop.
   */
  analyze(text: string): LocalIntent | null {
    const t = text.trim().replace(/[.!?]+$/, '');

    // Settings pages: "open bluetooth settings", "display settings", "settings for wifi"
    let m = t.match(/^(?:(?:open|show|go to)\s+)?(?:the\s+)?(.+?)\s+settings?$/i) || t.match(/^(?:open\s+)?settings?\s+(?:for\s+)?(.+)$/i);
    if (m && m[1].split(/\s+/).length <= 4) {
      const page = findSettingsPage(m[1]);
      if (page) return { tool: 'open_settings', args: { page: page.key }, description: `Open Settings → ${page.key}` };
    }
    if (/^(?:open\s+)?(?:windows\s+)?settings$/i.test(t)) return { tool: 'open_settings', args: { page: 'settings' }, description: 'Open Settings' };

    // "screenshot", "send me a screenshot", "take a screenshot of my screen"
    if (/^(?:(?:take|send|grab|show)\s+(?:me\s+)?)?(?:a\s+)?screen\s?shot(?:\s+of\s+(?:my|the)\s+screens?)?$/i.test(t))
      return { tool: 'take_screenshot', args: {}, description: 'Screenshot' };

    // "free up space", "clean up my disk", "disk cleanup"
    if (/^(?:free\s+up|clean\s?up|reclaim)\s+(?:some\s+)?(?:my\s+)?(?:disk\s+)?(?:space|disk|storage|drive)$|^disk\s+clean\s?up$/i.test(t))
      return { tool: 'analyze_disk_space', args: {}, description: 'What can be cleaned' };

    // "health check", "pc health report", "check my computer's health"
    if (/^(?:(?:pc|system|computer)\s+)?health(?:\s+(?:check|report))?$|^check\s+(?:my\s+|the\s+)?(?:pc|computer|system)(?:'s)?\s+health$/i.test(t))
      return { tool: 'health_report', args: {}, description: 'Health report' };

    // apps (winget): "install vlc", "update all apps", "which apps need updates"
    m = t.match(/^install\s+(?:the\s+)?(?:app\s+)?([\w.+ -]{2,60}?)(?:\s+app)?$/i);
    if (m && m[1].split(/\s+/).length <= 4 && !/\bupdates?\b/i.test(m[1])) return { tool: 'apps_install', args: { app: m[1].trim() }, description: `Install ${m[1].trim()} (winget)` };
    if (/^(?:update|upgrade)\s+all\s+(?:(?:my|the)\s+)?(?:apps|programs|software)$/i.test(t))
      return { tool: 'apps_upgrade', args: { app: 'all' }, description: 'Update all apps (winget)' };
    if (/^(?:check\s+(?:for\s+)?|any\s+)?app\s+updates$|^(?:which|what)\s+apps\s+(?:need|have)\s+updates$/i.test(t))
      return { tool: 'apps_updates', args: {}, description: 'Apps with updates' };
    if (/^(?:check\s+(?:for\s+)?)?windows\s+updates?$/i.test(t))
      return { tool: 'admin_task', args: { task: 'windows_update_scan' }, description: 'Check for Windows updates' };

    // repair routines: "fix my printer", "fix the internet", "fix windows update"
    m = t.match(/^fix\s+(?:my\s+|the\s+)?(internet|wi-?fi|network|printer|printing|sound|audio|search|windows\s+updates?|updates|system\s+files)$/i);
    if (m) {
      const w = m[1].toLowerCase().replace(/\s+/g, ' ');
      const routine = /internet|wi-?fi|network/.test(w) ? 'internet' : /print/.test(w) ? 'printer' : /sound|audio/.test(w) ? 'sound' : w === 'search' ? 'search' : /system/.test(w) ? 'system-files' : 'windows-update';
      return { tool: 'run_repair', args: { routine }, description: `Repair: ${routine}` };
    }

    // "what windows are open", "list windows"
    if (/^(?:list\s+(?:the\s+|my\s+)?(?:open\s+)?windows|what\s+windows\s+are\s+open)$/i.test(t)) return { tool: 'ui_list_windows', args: {}, description: 'Open windows' };

    // "open/launch/start <program>"
    m = t.match(/^(?:open|launch|start)\s+(.+?)(?:\s+(?:with|using)\s+(.+))?$/i);
    if (m && !this.looksLikeUrl(t)) {
      const target = m[1].toLowerCase().trim();
      const resolved = PROGRAM_ALIASES[target] || m[1].trim();
      // Only treat as program launch if it's short/simple (not a sentence)
      if (resolved.split(/\s+/).length <= 2 && resolved.length < 60) {
        return {
          tool: 'launch_program',
          args: { target: resolved },
          description: `Launch ${resolved}`,
        };
      }
    }

    // "open https://..." — URL launch
    m = t.match(/^(?:open|go to|browse)\s+(https?:\/\/\S+)$/i);
    if (m) {
      return { tool: 'launch_program', args: { target: m[1] }, description: `Open ${m[1]}` };
    }

    // "search for X in Y" / "find files named X in Y"
    m = t.match(/^(?:search|find)\s+(?:for\s+)?(?:files?\s+)?(?:named\s+)?["']?(.+?)["']?\s+in\s+(.+)$/i);
    if (m) {
      const [, what, where] = m;
      if (this.looksLikePath(where.trim())) {
        return {
          tool: 'search_files',
          args: { directory: where.trim(), namePattern: what.trim() },
          description: `Search for "${what.trim()}" in ${where.trim()}`,
        };
      }
    }

    // "search X for Y" (content search)
    m = t.match(/^search\s+(.+?)\s+for\s+(?:text\s+)?["'](.+?)["']$/i);
    if (m && this.looksLikePath(m[1].trim())) {
      return {
        tool: 'search_files',
        args: { directory: m[1].trim(), contentPattern: m[2].trim() },
        description: `Search ${m[1].trim()} for "${m[2].trim()}"`,
      };
    }

    // "system info" / "system status"
    if (/^(system|sys)\s*(info|status)$/i.test(t) || /^what('s| is) my (system|pc|machine)\s*(info|status)\??$/i.test(t)) {
      return { tool: 'get_system_info', args: {}, description: 'Get system info' };
    }

    // "list <path>" / "ls <path>" / "dir <path>"
    m = t.match(/^(?:list|ls|dir)\s+(.+)$/i);
    if (m && this.looksLikePath(m[1].trim())) {
      return { tool: 'list_directory', args: { path: m[1].trim() }, description: `List ${m[1].trim()}` };
    }

    return null;
  }

  private looksLikePath(s: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('.') || s.startsWith('~');
  }

  private looksLikeUrl(s: string): boolean {
    return /^https?:\/\//i.test(s);
  }
}
