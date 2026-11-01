/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Command policy: which shell commands may run without asking the owner.
 *
 * Default DENY, not a blocklist. Until 1.2.0 a list of 22 "destructive" regexes decided — anything
 * the list didn't name ran unattended, e.g. `Remove-Item file.txt`, `Set-Content`, `iex (iwr …)`,
 * `vssadmin delete shadows`, `schtasks /create`. Now a command runs without approval only when
 * EVERY command in it (pipelines, `;`, `&&`, script blocks, `$( )` sub-expressions…) is known to
 * be read-only. Anything unknown, any file redirection, any .NET method call that isn't a plain
 * string/format helper → the owner approves it in Telegram.
 *
 * Three verdicts:
 *   allow — read-only, runs immediately
 *   ask   — needs the owner's Approve in Telegram (auto-denied in unattended runs)
 *   deny  — never runs, not even with approval: touches a protected location (SensitivePaths) or
 *           is a classic attack/anti-recovery move (encoded commands, deleting restore points)
 *
 * TRUSTED_COMMANDS (.env, comma-separated, e.g. "git,npm,node") lets the owner skip approval for
 * tools they use all day — except the forms in ALWAYS_ASK (force pushes, recursive deletes…).
 */

import { config } from '../config';
import { sensitivePathIn } from './SensitivePaths';

export type Verdict = 'allow' | 'ask' | 'deny';
export interface PolicyDecision {
  verdict: Verdict;
  reason: string;
  /** 'ask' decisions that come in bursts (UI clicks in one window) can be approved for 10 min by this key — see Gate.ts */
  grantKey?: string;
}
export type ShellKind = 'powershell' | 'bash';

const allow = (reason = 'read-only'): PolicyDecision => ({ verdict: 'allow', reason });
const ask = (reason: string): PolicyDecision => ({ verdict: 'ask', reason });
const deny = (reason: string): PolicyDecision => ({ verdict: 'deny', reason });

/** Never run, whatever the owner taps: obfuscation and "destroy the way back" moves. */
const HARD_DENY: [RegExp, string][] = [
  [/\b(powershell|pwsh)(\.exe)?\b[^|;&\n]*\s[-/](e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s/i, 'encoded PowerShell command (hides what it does)'],
  [/\bvssadmin(\.exe)?\s+(delete|resize)\s+shadow/i, 'deletes restore points / shadow copies'],
  [/\bwmic(\.exe)?\b[^\n]*shadowcopy[^\n]*delete/i, 'deletes shadow copies'],
  [/win32_shadowcopy[^\n]*(delete|remove)/i, 'deletes shadow copies'],
  [/\bwbadmin(\.exe)?\s+delete\b/i, 'deletes Windows backups'],
  [/\bbcdedit(\.exe)?\b[^\n]*recoveryenabled\s+no/i, 'disables Windows recovery'],
  [/\breg(\.exe)?\s+save\s+hklm\\(sam|security|system)\b/i, 'dumps the Windows password hives'],
];

/** Even a TRUSTED_COMMANDS tool asks for these. Also the old 1.2.0 list, kept as a floor. */
const ALWAYS_ASK: RegExp[] = [
  /Remove-Item\b/i,
  /\b(rm|rmdir|rd|del|erase)\b/i,
  /\bformat\s+[a-z]:/i,
  /\b(shutdown|Restart-Computer|Stop-Computer|diskpart|bcdedit|takeown|Clear-Disk|Remove-Partition|Format-Volume)\b/i,
  /\breg(\.exe)?\s+(delete|add|import)\b/i,
  /\btaskkill\b/i,
  /\b(Stop|Disable|Set)-Service\b/i,
  /\bicacls\b[^\n]*\/(grant|deny|reset|setowner)/i,
  /\bgit\s+push\b[^\n]*(--force|-f\b|--delete|--mirror)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|filter-branch|update-ref\s+-d)/i,
  /\bnpm\s+(publish|unpublish|deprecate|owner)\b/i,
  /\b(Invoke-Expression|iex)\b/i,
  /\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget|Start-BitsTransfer|bitsadmin|certutil)\b/i,
  /\b(schtasks|New-ScheduledTask|Register-ScheduledTask|New-Service|sc\.exe\s+create)\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /\bnet(\.exe)?\s+(user|localgroup)\b[^\n]*\/(add|delete)/i,
];

// ── what counts as read-only ────────────────────────────────────────────────

/** PowerShell verbs whose cmdlets only read (Get-Process, Test-Path, Select-Object…). */
const SAFE_VERBS = new Set(['get', 'test', 'measure', 'select', 'sort', 'group', 'format', 'where', 'find', 'resolve', 'compare', 'convertto', 'convertfrom', 'join', 'split', 'show', 'read', 'search', 'trace', 'confirm', 'debug']);
/** Cmdlets with a safe verb that still change something. */
const UNSAFE_DESPITE_VERB = new Set(['format-volume', 'show-windowsdeveloperlicenseregistration']);

/** Exact command names (lower case, no .exe) that only read, whatever the arguments. */
const SAFE_COMMANDS = new Set([
  // PowerShell cmdlets / aliases
  'foreach-object', 'where-object', 'write-output', 'write-host', 'write-verbose', 'write-warning', 'write-error', 'write-information', 'write-debug',
  'out-string', 'out-null', 'out-host', 'out-default', 'start-sleep', 'import-csv', 'import-clixml', 'import-powershelldatafile',
  'set-location', 'push-location', 'pop-location', 'clear-host',
  'dir', 'ls', 'gci', 'cat', 'gc', 'type', 'echo', 'write', 'pwd', 'gl', 'cd', 'sl', 'chdir', 'pushd', 'popd', 'where', '?', '%', 'foreach',
  'select', 'ft', 'fl', 'fw', 'gp', 'gps', 'ps', 'gsv', 'gwmi', 'gcim', 'gi', 'gm', 'measure', 'group', 'diff', 'compare', 'h', 'history',
  'cls', 'clear', 'sleep', 'gcm', 'gal', 'gv', 'gdr', 'gjb', 'rvpa', 'ghy', 'man', 'help',
  // Windows native, read-only
  'whoami', 'hostname', 'ver', 'systeminfo', 'tasklist', 'findstr', 'more', 'tree', 'ping', 'tracert', 'pathping', 'nslookup', 'netstat',
  'arp', 'getmac', 'driverquery', 'quser', 'qwinsta', 'query', 'fc', 'comp', 'where.exe',
  // Unix tools (Claude Code's Bash tool runs Git Bash)
  'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'which', 'file', 'stat', 'du', 'df', 'uname', 'cut', 'tr', 'uniq', 'basename',
  'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', 'column', 'jq', 'od', 'xxd', 'hexdump', 'md5sum', 'sha1sum', 'sha256sum',
  'nl', 'tac', 'rev', 'seq', 'id', 'nproc', 'free', 'uptime', 'printf', 'less', 'cmp', 'locale', 'getconf', 'stat.exe',
]);

/** Commands that are read-only only with certain arguments. `rest` = everything after the name. */
const SAFE_WITH_ARGS: Record<string, (rest: string) => boolean> = {
  ipconfig: (r) => /^\s*(\/all|\/displaydns|\/\?)?\s*$/i.test(r),
  netsh: (r) => /\bshow\b/i.test(r) && !/\b(set|add|delete|reset|dump|import|exec|trace|install|uninstall)\b/i.test(r),
  'sc.exe': (r) => /^\s*(query|queryex|qc|qdescription|qfailure|qtriggerinfo|enumdepend|getdisplayname|getkeyname)\b/i.test(r),
  reg: (r) => /^\s*query\b/i.test(r),
  route: (r) => /^\s*print\b/i.test(r),
  schtasks: (r) => /^\s*\/query\b/i.test(r),
  wevtutil: (r) => /^\s*(qe|query-events|gl|get-log|el|enum-logs|gli|get-log-info)\b/i.test(r),
  powercfg: (r) => /^\s*[-/](l|list|q|query|a|availablesleepstates|getactivescheme|aliases|devicequery)\b/i.test(r),
  winget: (r) => /^\s*(list|ls|search|find|show|view|--version|-v|--info)\b/i.test(r) || /^\s*upgrade\s*$/i.test(r),
  node: (r) => /^\s*(-v|--version)\s*$/i.test(r),
  python: (r) => /^\s*(-V|--version)\s*$/.test(r),
  py: (r) => /^\s*(-V|--version|--list|-0)\s*$/.test(r),
  npm: (r) => /^\s*(ls|list|ll|la|view|info|show|outdated|-v|--version|root|prefix|help|explain|why|config\s+(get|list|ls)|audit(?!\s+fix))\b/i.test(r),
  npx: (r) => /^\s*tsc\s+--noEmit\b/i.test(r),
  date: (r) => !/\s-s\b|--set\b/.test(' ' + r),
  find: (r) => !/\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/.test(' ' + r),
  sort: (r) => !/(^|\s)(-o|--output)\b/.test(r),
  sed: (r) => /^\s*-n\b/.test(r) && !/(^|\s)-i/.test(r),
  git: (r) => {
    const m = /^\s*(?:-C\s+\S+\s+)?([a-z-]+)(.*)$/i.exec(r);
    if (!m) return false;
    const [, sub, rest] = m;
    if (['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'whatchanged', 'rev-list', 'merge-base', 'for-each-ref', 'name-rev', 'cherry', 'count-objects', 'fsck', 'version', 'help'].includes(sub)) return true;
    if (sub === 'branch') return !/\s-(d|D|m|M|c|C|u|f)\b|--(delete|move|copy|set-upstream|unset-upstream|force|edit-description)/.test(' ' + rest);
    if (sub === 'remote') return /^\s*(-v|--verbose|show|get-url)?\b/.test(rest) && !/\b(add|remove|rm|rename|set-url|prune|update|set-head|set-branches)\b/.test(rest);
    if (sub === 'tag') return /^\s*(-l|--list|-n\d*)?\s*$/.test(rest);
    if (sub === 'stash') return /^\s*(list|show)\b/.test(rest);
    if (sub === 'config') return /\s--(get|get-all|get-regexp|list|l)\b|^\s*-l\b/.test(' ' + rest);
    if (sub === 'reflog') return /^\s*(show)?\b/.test(rest) && !/\b(expire|delete)\b/.test(rest);
    return false;
  },
};

/** .NET static types whose methods only compute (no files, no processes). */
const SAFE_TYPES = /^(system\.)?(math|datetime|timespan|string|int|int32|int64|long|double|decimal|char|bool|boolean|convert|guid|regex|text\.regularexpressions\.regex|io\.path|bitconverter|uri|version|globalization\.cultureinfo|net\.ipaddress|environment|text\.encoding)$/i;
const SAFE_ENVIRONMENT_METHODS = /^(getfolderpath|getenvironmentvariable|getlogicaldrives|expandenvironmentvariables|getcommandlineargs)$/i;
/** Instance/static methods that only compute a value. */
const SAFE_METHODS = new Set([
  'tostring', 'trim', 'trimstart', 'trimend', 'substring', 'split', 'replace', 'tolower', 'toupper', 'tolowerinvariant', 'toupperinvariant',
  'contains', 'startswith', 'endswith', 'indexof', 'lastindexof', 'padleft', 'padright', 'join', 'format', 'gettype', 'equals', 'compareto',
  'round', 'floor', 'ceiling', 'abs', 'max', 'min', 'pow', 'sqrt', 'log', 'log10', 'truncate', 'now', 'parse', 'tryparse', 'parseexact',
  'adddays', 'addhours', 'addminutes', 'addseconds', 'addmonths', 'addyears', 'toshortdatestring', 'tolongdatestring', 'toshorttimestring',
  'touniversaltime', 'tolocaltime', 'tostring', 'getfilename', 'getextension', 'getdirectoryname', 'getfilenamewithoutextension', 'combine',
  'getfullpath', 'getpathroot', 'isnullorempty', 'isnullorwhitespace', 'tobase64string', 'frombase64string', 'getbytes', 'getstring',
  'toint32', 'toint64', 'todouble', 'toboolean', 'tochararray', 'newguid', 'match', 'matches', 'ismatch', 'escape', 'getenumerator',
  'containskey', 'containsvalue', 'getvalue', 'tostring', 'todatetime', 'totalseconds', 'totalminutes', 'totalhours', 'totaldays',
  'getfolderpath', 'getenvironmentvariable', 'getlogicaldrives', 'expandenvironmentvariables', 'getcommandlineargs', 'insert',
  'normalize', 'reverse', 'sort', 'where', 'foreach', 'count', 'distinct', 'first', 'last', 'take', 'skip', 'toarray', 'tolist',
]);

/** Interpreters / launchers: running them runs arbitrary code, so never "read-only". */
const CODE_RUNNERS = new Set(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'wsl', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'perl', 'ruby', 'awk', 'gawk', 'xargs', 'env', 'eval', 'exec', 'sudo', 'runas', 'start', 'start-process', 'saps', 'invoke-command', 'icm', 'invoke-item', 'ii', 'invoke-expression', 'iex', '&', '.']);

// ── tokenizer ───────────────────────────────────────────────────────────────

interface Scan {
  /** command text with string contents blanked out ("" / '') */
  text: string;
  /** set when the command can't be analyzed safely (here-strings, escapes, unclosed quotes…) */
  opaque?: string;
}

/** Blank out string literal contents so their words aren't mistaken for commands. Sub-expressions
 * inside double-quoted strings ("$(Remove-Item x)") DO run — those make the command opaque. */
function blankStrings(cmd: string, shell: ShellKind): Scan {
  if (/@['"]\s*\r?\n/.test(cmd) || /<<-?\s*['"]?\w+/.test(cmd)) return { text: cmd, opaque: 'here-string / here-document' };
  let out = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" ) {
      let j = i + 1;
      for (; j < cmd.length; j++) {
        if (cmd[j] === "'") {
          if (shell === 'powershell' && cmd[j + 1] === "'") { j++; continue; }
          break;
        }
      }
      if (j >= cmd.length) return { text: cmd, opaque: 'unclosed quote' };
      out += "''";
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length; j++) {
        if (cmd[j] === '`' && shell === 'powershell') { j++; continue; }
        if (cmd[j] === '\\' && shell === 'bash') { j++; continue; }
        if (cmd[j] === '"') {
          if (shell === 'powershell' && cmd[j + 1] === '"') { j++; continue; }
          break;
        }
      }
      if (j >= cmd.length) return { text: cmd, opaque: 'unclosed quote' };
      const inner = cmd.slice(i + 1, j);
      if (/\$\(/.test(inner) || (shell === 'bash' && /`/.test(inner))) return { text: cmd, opaque: 'command inside a string' };
      out += '""';
      i = j;
    } else {
      out += c;
    }
  }
  if (shell === 'powershell' && /`[^\s]/.test(out)) return { text: out, opaque: 'escape characters (`) in the command' };
  if (shell === 'bash' && /`/.test(out)) return { text: out, opaque: 'backtick command substitution' };
  return { text: out };
}

/** Split into the pieces that each start with a command: pipelines, ;, &&, ||, newlines,
 * script blocks { }, sub-expressions $( ) @( ) ( ). */
function segments(text: string): string[] {
  return text
    .replace(/#[^\n]*/g, (m, off: number) => (off === 0 || /\s/.test(text[off - 1]) ? '' : m)) // comments
    .split(/\|\||&&|[|;\n\r{}()]|\$\(|@\(/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** File redirections write files: only > $null / 2>&1 / > /dev/null are fine. */
function writesByRedirection(text: string): boolean {
  const re = /(\d|\*|&)?>>?\s*(&\d|\$null|\/dev\/null|nul\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (text[m.index - 1] === '-' || text[m.index - 1] === '=') continue; // -> / => / >= are not redirections
    if (!m[2]) return true;
  }
  return false;
}

function commandName(word: string): string {
  const n = word.replace(/^['"]|['"]$/g, '').split(/[\\/]/).pop()!.toLowerCase();
  // sc.exe / where.exe differ from the PowerShell aliases sc (Set-Content) / where (Where-Object)
  return n === 'sc.exe' || n === 'where.exe' ? n : n.replace(/\.(exe|com)$/, '');
}

function isSafeName(name: string, rest: string): boolean {
  if (SAFE_COMMANDS.has(name)) return true;
  const withArgs = SAFE_WITH_ARGS[name];
  if (withArgs) return withArgs(rest);
  const verb = /^([a-z]+)-[a-z0-9]+$/i.exec(name)?.[1];
  return !!verb && SAFE_VERBS.has(verb) && !UNSAFE_DESPITE_VERB.has(name);
}

function trustedCommands(): Set<string> {
  return new Set(config.security.trustedCommands.map((c) => c.toLowerCase().replace(/\.exe$/, '')));
}

/** The verdict for one shell command line. */
export function classifyCommand(command: string, shell: ShellKind = 'powershell'): PolicyDecision {
  const cmd = String(command || '').trim();
  if (!cmd) return allow('empty');
  for (const [re, why] of HARD_DENY) if (re.test(cmd)) return deny(why);
  const sensitive = sensitivePathIn(cmd);
  if (sensitive) return deny(`touches a protected location (${sensitive})`);

  const scan = blankStrings(cmd, shell);
  if (scan.opaque) return ask(`can't be checked automatically: ${scan.opaque}`);
  if (writesByRedirection(scan.text)) return ask('writes to a file (redirection)');

  const unknown: string[] = [];
  // .NET method calls: (Get-Item x).Delete(), [IO.File]::WriteAllText(…)
  if (shell === 'powershell') {
    const statics = scan.text.matchAll(/\[([\w.]+)\]::(\w+)/g);
    for (const m of statics) {
      const type = m[1].toLowerCase(), method = m[2].toLowerCase();
      const ok = SAFE_TYPES.test(type) && (!/^(system\.)?environment$/.test(type) || SAFE_ENVIRONMENT_METHODS.test(method));
      if (!ok) unknown.push(`[${m[1]}]::${m[2]}`);
    }
    for (const m of scan.text.replace(/\[[\w.]+\]::\w+/g, '').matchAll(/\.(\w+)\s*\(/g)) {
      if (!SAFE_METHODS.has(m[1].toLowerCase())) unknown.push(`.${m[1]}()`);
    }
  }

  for (let seg of segments(scan.text)) {
    // assignments and casts in front of the command: $x = Get-Thing / [int]$n = …
    seg = seg.replace(/^(\[[\w.\[\]]+\]\s*)*\$[\w:]+\s*[-+*/]?=\s*(?!=)/, '').replace(/^(\[[\w.\[\]]+\]\s*)+/, '').trim();
    if (shell === 'bash') seg = seg.replace(/^(\w+=\S*\s+)+/, '').trim(); // VAR=value cmd
    else seg = seg.replace(/^\w+\s*=\s*/, '').trim(); // a hashtable entry: @{ Name = …; Expression = … }
    if (!seg) continue;
    const first = seg.split(/\s+/)[0];
    // expressions, not commands: $var.Prop, 'text', 42, -not …, operators, @{ }, ).Member
    // (but `. script` dot-sources and `.\x.ps1` runs a script: those are commands)
    if (first !== '%' && (/^(\$|''|""|\d|-[a-z]|[!,+*/=<>:]|@)/i.test(first) || /^\.[a-z_]/i.test(first))) continue;
    if (first === '&' || /^&\S/.test(first)) { unknown.push('& (call operator)'); continue; }
    const name = commandName(first);
    const rest = seg.slice(first.length);
    if (CODE_RUNNERS.has(name)) { unknown.push(name); continue; }
    if (name === 'foreach-object' || name === '%' || name === 'foreach') {
      // `% Delete` / ForEach-Object -MemberName Kill calls a method on every object
      if (rest.trim() && !/^\s*-(process|begin|end)\s*$/i.test(rest)) unknown.push(`${name} ${rest.trim().split(/\s+/)[0]}`);
      continue;
    }
    if (name === 'tee-object' || name === 'tee') { if (!/-variable\b/i.test(rest)) unknown.push(name); continue; }
    if (!isSafeName(name, rest)) unknown.push(name);
  }

  if (unknown.length === 0) return allow();
  const trusted = trustedCommands();
  const untrusted = unknown.filter((u) => !trusted.has(u.toLowerCase()));
  if (untrusted.length === 0 && !ALWAYS_ASK.some((re) => re.test(cmd))) return allow('trusted command (TRUSTED_COMMANDS)');
  return ask(`not known to be read-only: ${[...new Set(unknown)].slice(0, 4).join(', ')}`);
}
