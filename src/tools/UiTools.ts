/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * UI Automation (1.5.0): see and operate the apps on screen through Windows' accessibility tree
 * (System.Windows.Automation) — buttons, menus, text boxes by name — which is far more reliable
 * than guessing coordinates from a screenshot. One PowerShell script, one action per call; the
 * parameters travel as base64 JSON in an environment variable, never inside the script.
 *
 * Approval (AITools.toolCallDecision): listing/inspecting windows and focus/min/max/snap run
 * freely; click / type / keys ask, with "approve all here for 10 min" keyed by the window; close
 * always asks (unsaved work).
 */

import { execFileKillable } from '../utils/proc';
import type { ToolDefinition } from '../providers/AIProvider';
import type { ToolResult } from './AITools';
import { childEnv } from '../security/SecretStore';

const PS_UI = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
[void][W.U]::SetProcessDPIAware()
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AIWA_UI)) | ConvertFrom-Json
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Any = [System.Windows.Automation.Condition]::TrueCondition

function TopWindows { @($A::RootElement.FindAll($Scope::Children, $Any) | Where-Object { $_.Current.Name }) }
function FindWindow([string]$t) {
  $all = TopWindows
  $w = @($all | Where-Object { $_.Current.Name -ieq $t })
  if (-not $w) { $w = @($all | Where-Object { $_.Current.Name.ToLower().Contains($t.ToLower()) }) }
  if (-not $w) { throw "No window whose title contains '$t'. Use ui_list_windows." }
  $w[0]
}
function Focus($w) {
  $h = [IntPtr]$w.Current.NativeWindowHandle
  if ([W.U]::IsIconic($h)) { [void][W.U]::ShowWindow($h, 9) }
  [W.U]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W.U]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][W.U]::SetForegroundWindow($h); Start-Sleep -Milliseconds 250
}
function Walk($w, [int]$maxDepth, [int]$max) {
  $list = New-Object System.Collections.ArrayList
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($w, 0))
  while ($stack.Count -gt 0 -and $list.Count -lt $max) {
    $item = $stack.Pop(); $el = $item[0]; $d = $item[1]
    if ($d -gt 0) { [void]$list.Add(@($el, $d)) }
    if ($d -lt $maxDepth) {
      $kids = New-Object System.Collections.ArrayList
      $c = $walker.GetFirstChild($el)
      while ($c -ne $null) { [void]$kids.Add($c); $c = $walker.GetNextSibling($c) }
      for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], ($d + 1))) }
    }
  }
  $list
}
function Describe($el) {
  $c = $el.Current
  $t = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  $s = "[$t]"
  if ($c.Name) { $s += " ""$($c.Name)""" }
  if ($c.AutomationId -and $c.AutomationId -notmatch '^\d+$') { $s += " id=$($c.AutomationId)" }
  if (-not $c.IsEnabled) { $s += ' (disabled)' }
  $s
}
function FindTarget($w, [string]$target) {
  if ($target -match '^#(\d+)$') {
    $n = [int]$Matches[1]; $d = if ($p.depth) { [int]$p.depth } else { 6 }; $list = Walk $w $d 400
    if ($n -lt 1 -or $n -gt $list.Count) { throw "No element #$n (run ui_inspect again — the window may have changed)" }
    return $list[$n - 1][0]
  }
  $all = @($w.FindAll($Scope::Descendants, $Any))
  $hit = @($all | Where-Object { $_.Current.Name -ieq $target -and $_.Current.IsEnabled })
  if (-not $hit) { $hit = @($all | Where-Object { $_.Current.AutomationId -ieq $target }) }
  if (-not $hit) { $hit = @($all | Where-Object { $_.Current.Name -and $_.Current.Name.ToLower().Contains($target.ToLower()) -and $_.Current.IsEnabled }) }
  if (-not $hit) { throw "No element named '$target' in '$($w.Current.Name)'. Use ui_inspect to see what is there." }
  $hit[0]
}
function Escape([string]$s) { ($s.ToCharArray() | ForEach-Object { if ('+^%~(){}[]'.Contains([string]$_)) { '{' + $_ + '}' } else { [string]$_ } }) -join '' }

switch ($p.action) {
  'list' {
    TopWindows | ForEach-Object { $c = $_.Current; $pn = (Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue).ProcessName; "- $($c.Name)  [$pn]" }
  }
  'inspect' {
    $w = FindWindow $p.window
    $d = if ($p.depth) { [int]$p.depth } else { 6 }
    "Window: $($w.Current.Name)"
    $i = 0
    foreach ($item in (Walk $w $d 400)) { $i++; ('#' + $i).PadRight(6) + ('  ' * ($item[1] - 1)) + (Describe $item[0]) }
  }
  'click' {
    $w = FindWindow $p.window; $el = FindTarget $w $p.target
    $done = $null
    foreach ($try in @(
      @([System.Windows.Automation.InvokePattern]::Pattern, { param($x) $x.Invoke() }, 'pressed'),
      @([System.Windows.Automation.TogglePattern]::Pattern, { param($x) $x.Toggle() }, 'toggled'),
      @([System.Windows.Automation.SelectionItemPattern]::Pattern, { param($x) $x.Select() }, 'selected'),
      @([System.Windows.Automation.ExpandCollapsePattern]::Pattern, { param($x) $x.Expand() }, 'expanded'))) {
      $pat = $null
      if ($el.TryGetCurrentPattern($try[0], [ref]$pat)) { & $try[1] $pat; $done = $try[2]; break }
    }
    if (-not $done) {
      Focus $w; $pt = $el.GetClickablePoint()
      [void][W.U]::SetCursorPos([int]$pt.X, [int]$pt.Y); [W.U]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [W.U]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      $done = 'clicked'
    }
    "$(Describe $el): $done"
  }
  'type' {
    $w = FindWindow $p.window
    if ($p.target) {
      $el = FindTarget $w $p.target; $vp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and -not $vp.Current.IsReadOnly -and -not $p.enter) {
        $vp.SetValue([string]$p.text); "Set $(Describe $el) to the text"; break
      }
      Focus $w; $el.SetFocus()
    } else { Focus $w }
    [System.Windows.Forms.SendKeys]::SendWait((Escape ([string]$p.text)) + $(if ($p.enter) { '{ENTER}' } else { '' }))
    'Typed the text' + $(if ($p.enter) { ' and pressed Enter' } else { '' })
  }
  'keys' {
    $w = FindWindow $p.window; Focus $w
    [System.Windows.Forms.SendKeys]::SendWait([string]$p.keys)
    "Sent $($p.keys) to $($w.Current.Name)"
  }
  'window' {
    $w = FindWindow $p.window; $h = [IntPtr]$w.Current.NativeWindowHandle
    switch ($p.op) {
      'focus' { Focus $w }
      'minimize' { [void][W.U]::ShowWindow($h, 6) }
      'maximize' { [void][W.U]::ShowWindow($h, 3) }
      'restore' { [void][W.U]::ShowWindow($h, 9) }
      'close' { $wp = $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern); $wp.Close() }
      { $_ -in 'snap-left', 'snap-right' } {
        [void][W.U]::ShowWindow($h, 9)
        $a = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea; $half = [int]($a.Width / 2)
        $x = if ($p.op -eq 'snap-left') { $a.Left } else { $a.Left + $half }
        [void][W.U]::SetWindowPos($h, [IntPtr]::Zero, $x, $a.Top, $half, $a.Height, 0x0040)
      }
      default { throw "Unknown window action '$($p.op)'" }
    }
    "$($w.Current.Name): $($p.op)"
  }
  default { throw "Unknown UI action '$($p.action)'" }
}`;

let uiSignal: AbortSignal | undefined;

async function ui(params: Record<string, unknown>, timeoutMs = 45000): Promise<ToolResult> {
  const r = await execFileKillable(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PS_UI],
    { env: childEnv({ AIWA_UI: Buffer.from(JSON.stringify(params), 'utf8').toString('base64') }), windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    uiSignal
  );
  if (r.cancelled) return { success: false, error: 'Cancelled by the user' };
  const out = r.stdout.trim();
  if (r.error) return { success: false, error: (r.stderr.trim().split(/\r?\n/).find((l) => l.trim() && !/^At line|^\+|CategoryInfo|FullyQualifiedErrorId/.test(l)) || r.error.message).slice(0, 500) };
  return { success: true, output: out.slice(0, 12000) || 'Done.' };
}

export const UI_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ui_list_windows',
    description: 'List the open windows on the screen (titles and programs). Start here before operating an app.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'ui_inspect',
    description: 'Show the controls inside a window (buttons, menus, text boxes…) as a numbered tree. Use the names or #numbers with ui_click / ui_type.',
    parameters: {
      type: 'object',
      properties: { window: { type: 'string', description: 'Window title or part of it' }, depth: { type: 'number', description: 'Tree depth, default 6' } },
      required: ['window'],
    },
  },
  {
    name: 'ui_click',
    description: 'Click / press a control in a window by its name, automation id, or #number from ui_inspect. Asks the user first.',
    parameters: { type: 'object', properties: { window: { type: 'string' }, target: { type: 'string', description: 'Control name, id or #number' } }, required: ['window', 'target'] },
  },
  {
    name: 'ui_type',
    description: 'Type text into a window — into a named control (target) or wherever the cursor is; enter=true presses Enter after. Asks the user first.',
    parameters: {
      type: 'object',
      properties: { window: { type: 'string' }, text: { type: 'string' }, target: { type: 'string' }, enter: { type: 'boolean' } },
      required: ['window', 'text'],
    },
  },
  {
    name: 'ui_keys',
    description: 'Send a keyboard shortcut to a window, SendKeys syntax: ^s = Ctrl+S, %{F4} = Alt+F4, {ENTER}, {TAB}, +{TAB}. Asks the user first.',
    parameters: { type: 'object', properties: { window: { type: 'string' }, keys: { type: 'string' } }, required: ['window', 'keys'] },
  },
  {
    name: 'ui_window',
    description: 'Arrange a window: focus, minimize, maximize, restore, snap-left, snap-right, or close (close asks first).',
    parameters: {
      type: 'object',
      properties: { window: { type: 'string' }, action: { type: 'string', enum: ['focus', 'minimize', 'maximize', 'restore', 'snap-left', 'snap-right', 'close'] } },
      required: ['window', 'action'],
    },
  },
];

export const UI_TOOL_NAMES = new Set(UI_TOOL_DEFINITIONS.map((d) => d.name));

export async function executeUiTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const s = (k: string) => String(args[k] ?? '');
  uiSignal = signal;
  switch (name) {
    case 'ui_list_windows':
      return ui({ action: 'list' });
    case 'ui_inspect':
      return ui({ action: 'inspect', window: s('window'), depth: Number(args.depth) || 6 }, 90000);
    case 'ui_click':
      return ui({ action: 'click', window: s('window'), target: s('target') });
    case 'ui_type':
      return ui({ action: 'type', window: s('window'), target: s('target'), text: s('text'), enter: args.enter === true });
    case 'ui_keys':
      return ui({ action: 'keys', window: s('window'), keys: s('keys') });
    case 'ui_window':
      return ui({ action: 'window', window: s('window'), op: s('action') });
    default:
      return { success: false, error: `Unknown UI tool: ${name}` };
  }
}
