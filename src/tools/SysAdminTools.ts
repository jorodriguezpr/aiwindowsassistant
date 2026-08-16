/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Curated, structured Windows admin tools for the local-model engine (AgentLoop). The Claude
 * Code engine has its own built-in Bash tool and doesn't consume these — this library exists
 * specifically because the local-model path only had raw execute_command before. Roughly a dozen
 * tools, not an attempt at the original AiAgentAssistant's 100+ — each returns parsed JSON rather
 * than raw PowerShell text where practical, for more reliable model consumption.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../providers/AIProvider';
import type { ToolResult } from './AITools';

const execAsync = promisify(exec);

async function runPowerShellJson(script: string, timeoutMs = 30000): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execAsync(script, {
      shell: 'powershell.exe',
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1' },
    });
    const trimmed = stdout.trim();
    if (!trimmed) return { success: true, output: '[]' };
    try {
      JSON.parse(trimmed); // validate — pass through as-is if valid
      return { success: true, output: trimmed };
    } catch {
      return { success: true, output: trimmed, note: 'not valid JSON, raw output returned' };
    }
  } catch (err) {
    const e = err as { message?: string; stderr?: string };
    return { success: false, error: e.message, stderr: (e.stderr || '').slice(0, 500) };
  }
}

export const SYSADMIN_TOOL_NAMES = new Set([
  'get_disk_usage',
  'list_processes',
  'list_services',
  'service_control',
  'get_event_log_errors',
  'get_network_info',
  'firewall_rule_status',
  'firewall_rule_manage',
  'list_scheduled_tasks',
  'get_installed_software',
  'get_startup_programs',
]);

export const SYSADMIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_disk_usage',
    description: 'List all drives with total/free space in GB.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_processes',
    description: 'List top running processes sorted by CPU or memory usage.',
    parameters: {
      type: 'object',
      properties: {
        sortBy: { type: 'string', enum: ['cpu', 'memory'], description: 'Default: cpu' },
        top: { type: 'number', description: 'Max results, default 15' },
      },
    },
  },
  {
    name: 'list_services',
    description: 'List Windows services, optionally filtered by name substring or status.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Name substring filter (optional)' },
        status: { type: 'string', enum: ['Running', 'Stopped'], description: 'Filter by status (optional)' },
      },
    },
  },
  {
    name: 'service_control',
    description: 'Start, stop, or restart a Windows service (destructive — requires approval).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Service name (not display name)' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'] },
      },
      required: ['name', 'action'],
    },
  },
  {
    name: 'get_event_log_errors',
    description: 'Recent Error/Warning/Critical entries from a Windows event log.',
    parameters: {
      type: 'object',
      properties: {
        logName: { type: 'string', description: 'Default: Application' },
        hours: { type: 'number', description: 'Look-back window, default 24' },
        maxResults: { type: 'number', description: 'Default 20' },
      },
    },
  },
  {
    name: 'get_network_info',
    description: 'Local IPv4 addresses and listening TCP ports.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'firewall_rule_status',
    description: 'List Windows Firewall rules, optionally filtered by display-name substring.',
    parameters: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Display-name substring filter (optional)' } },
    },
  },
  {
    name: 'firewall_rule_manage',
    description:
      'Enable/disable an existing firewall rule by exact display name, or create/remove a simple inbound block rule for a port (destructive — requires approval).',
    parameters: {
      type: 'object',
      properties: {
        ruleName: { type: 'string', description: 'Exact rule display name' },
        action: { type: 'string', enum: ['enable', 'disable', 'create-block', 'remove'] },
        port: { type: 'number', description: 'Required for create-block' },
        protocol: { type: 'string', enum: ['TCP', 'UDP'], description: 'Default TCP, used with create-block' },
      },
      required: ['ruleName', 'action'],
    },
  },
  {
    name: 'list_scheduled_tasks',
    description: 'List Windows Scheduled Tasks (general OS visibility, not this app\'s own /schedule tasks).',
    parameters: {
      type: 'object',
      properties: { includeSystem: { type: 'boolean', description: 'Include Microsoft/Windows built-in tasks, default false' } },
    },
  },
  {
    name: 'get_installed_software',
    description: 'List installed software from the registry uninstall keys.',
    parameters: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Name substring filter (optional)' } },
    },
  },
  {
    name: 'get_startup_programs',
    description: 'List programs configured to run at Windows startup.',
    parameters: { type: 'object', properties: {} },
  },
];

export async function executeSysAdminTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'get_disk_usage':
      return runPowerShellJson(
        "Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, FileSystemLabel, " +
          "@{N='SizeGB';E={[math]::Round($_.Size/1GB,2)}}, @{N='FreeGB';E={[math]::Round($_.SizeRemaining/1GB,2)}} | ConvertTo-Json"
      );

    case 'list_processes': {
      const sortBy = args.sortBy === 'memory' ? 'WS' : 'CPU';
      const top = typeof args.top === 'number' ? args.top : 15;
      return runPowerShellJson(
        `Get-Process | Sort-Object ${sortBy} -Descending | Select-Object -First ${top} Name, Id, ` +
          "@{N='CPU';E={[math]::Round($_.CPU,1)}}, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json"
      );
    }

    case 'list_services': {
      const filters: string[] = [];
      if (typeof args.filter === 'string' && args.filter) filters.push(`$_.Name -like '*${psEscape(args.filter)}*'`);
      if (args.status === 'Running' || args.status === 'Stopped') filters.push(`$_.Status -eq '${args.status}'`);
      const where = filters.length ? ` | Where-Object { ${filters.join(' -and ')} }` : '';
      return runPowerShellJson(`Get-Service${where} | Select-Object Name, DisplayName, Status | ConvertTo-Json`);
    }

    case 'service_control': {
      const svcName = psEscape(String(args.name || ''));
      const action = String(args.action || '');
      const cmd =
        action === 'start'
          ? `Start-Service -Name '${svcName}'`
          : action === 'stop'
            ? `Stop-Service -Name '${svcName}' -Force`
            : action === 'restart'
              ? `Restart-Service -Name '${svcName}' -Force`
              : null;
      if (!cmd) return { success: false, error: `Unknown action: ${action}` };
      return runPowerShellJson(`${cmd}; Get-Service -Name '${svcName}' | Select-Object Name, Status | ConvertTo-Json`);
    }

    case 'get_event_log_errors': {
      const logName = typeof args.logName === 'string' ? psEscape(args.logName) : 'Application';
      const hours = typeof args.hours === 'number' ? args.hours : 24;
      const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 20;
      return runPowerShellJson(
        `Get-WinEvent -FilterHashtable @{LogName='${logName}'; Level=1,2,3; StartTime=(Get-Date).AddHours(-${hours})} ` +
          `-MaxEvents ${maxResults} -ErrorAction SilentlyContinue | Select-Object TimeCreated, LevelDisplayName, ProviderName, Id, ` +
          "@{N='Message';E={$_.Message.Substring(0,[Math]::Min(200,$_.Message.Length))}} | ConvertTo-Json"
      );
    }

    case 'get_network_info':
      return runPowerShellJson(
        '$ip = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "169.254.*" } | ' +
          "Select-Object IPAddress, InterfaceAlias; " +
          '$ports = Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess -Unique; ' +
          '@{ addresses = $ip; listeningPorts = $ports } | ConvertTo-Json -Depth 4'
      );

    case 'firewall_rule_status': {
      const filter = typeof args.filter === 'string' && args.filter ? ` | Where-Object { $_.DisplayName -like '*${psEscape(args.filter)}*' }` : '';
      return runPowerShellJson(`Get-NetFirewallRule${filter} | Select-Object -First 40 DisplayName, Enabled, Direction, Action | ConvertTo-Json`);
    }

    case 'firewall_rule_manage': {
      const ruleName = psEscape(String(args.ruleName || ''));
      const action = String(args.action || '');
      if (action === 'enable') return runPowerShellJson(`Enable-NetFirewallRule -DisplayName '${ruleName}'; 'ok' | ConvertTo-Json`);
      if (action === 'disable') return runPowerShellJson(`Disable-NetFirewallRule -DisplayName '${ruleName}'; 'ok' | ConvertTo-Json`);
      if (action === 'remove') return runPowerShellJson(`Remove-NetFirewallRule -DisplayName '${ruleName}' -ErrorAction SilentlyContinue; 'ok' | ConvertTo-Json`);
      if (action === 'create-block') {
        const port = args.port;
        if (typeof port !== 'number') return { success: false, error: 'port is required for create-block' };
        const protocol = args.protocol === 'UDP' ? 'UDP' : 'TCP';
        return runPowerShellJson(
          `New-NetFirewallRule -DisplayName '${ruleName}' -Direction Inbound -Protocol ${protocol} -LocalPort ${port} -Action Block; 'ok' | ConvertTo-Json`
        );
      }
      return { success: false, error: `Unknown action: ${action}` };
    }

    case 'list_scheduled_tasks': {
      const includeSystem = args.includeSystem === true;
      const where = includeSystem ? '' : " | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' }";
      return runPowerShellJson(`Get-ScheduledTask${where} | Select-Object TaskName, State, TaskPath | ConvertTo-Json`);
    }

    case 'get_installed_software': {
      const filter = typeof args.filter === 'string' && args.filter ? ` | Where-Object { $_.DisplayName -like '*${psEscape(args.filter)}*' }` : '';
      return runPowerShellJson(
        "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, " +
          "HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | " +
          `Where-Object { $_.DisplayName }${filter} | Select-Object DisplayName, DisplayVersion, Publisher | Sort-Object DisplayName | ConvertTo-Json`
      );
    }

    case 'get_startup_programs':
      return runPowerShellJson('Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location, User | ConvertTo-Json');

    default:
      return { success: false, error: `Unknown sysadmin tool: ${name}` };
  }
}

/** Minimal escaping for values interpolated into single-quoted PowerShell strings. */
function psEscape(value: string): string {
  return value.replace(/'/g, "''");
}
