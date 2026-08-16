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
    const t = text.trim();

    // "open/launch/start <program>"
    let m = t.match(/^(?:open|launch|start)\s+(.+?)(?:\s+(?:with|using)\s+(.+))?$/i);
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
