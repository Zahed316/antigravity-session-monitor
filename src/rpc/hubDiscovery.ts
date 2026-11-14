import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HubEndpoint {
  port: number;
  csrfToken: string;
  host: string;
  source: 'exports' | 'process' | 'wsl-host';
}

export interface HubDiscoveryDeps {
  extensionExports?: { port?: number; csrfToken?: string } | null;
  getExtension?: (extensionId: string) => { exports?: { port?: number; csrfToken?: string } } | undefined;
  workspacePaths?: string[];
  execFileAsync?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  procVersionText?: string;
  resolvConfText?: string;
  readFile?: (path: string, encoding: string) => Promise<string>;
}

interface ProcessMatch {
  port: number;
  csrfToken: string;
  score: number; // 3: matching workspace, 2: bare hub, 1: other workspace
}

function normalizePath(p: string): string {
  let s = p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  while (s.endsWith('/') && s.length > 1) {
    s = s.slice(0, -1);
  }
  return s.toLowerCase();
}

function isPathMatch(targetPath: string, workspacePaths: string[]): boolean {
  if (workspacePaths.length === 0) {
    return false;
  }
  const normTarget = normalizePath(targetPath);
  for (const ws of workspacePaths) {
    const normWs = normalizePath(ws);
    if (normTarget === normWs || normTarget.startsWith(normWs + '/') || normWs.startsWith(normTarget + '/')) {
      return true;
    }
  }
  return false;
}

function extractCommandLineCandidate(cmd: string, workspacePaths: string[]): ProcessMatch | null {
  if (!/(?:agy|language_server)/i.test(cmd)) {
    return null;
  }

  // Check app_data_dir if present
  const appDataMatch = cmd.match(/(?:--app[-_]data[-_]dir)[=\s]+["']?([^\s"']+)["']?/i);
  if (appDataMatch) {
    const dirVal = appDataMatch[1].toLowerCase();
    if (dirVal !== 'antigravity') {
      return null; // Ignore vanilla Codeium or other app data dirs
    }
  } else if (/language_server/i.test(cmd) && !/antigravity/i.test(cmd) && !/agy/i.test(cmd)) {
    return null;
  }

  // Extract port: --hub-port or --extension_server_port
  const portMatch = cmd.match(/(?:--hub[-_]port|--extension[-_]server[-_]port)[=\s]+["']?(\d+)["']?/i);
  if (!portMatch) {
    return null;
  }
  const port = parseInt(portMatch[1], 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    return null;
  }

  // Extract csrf_token: --csrf_token or --csrf-token
  const csrfMatch = cmd.match(/(?:--csrf[-_]token)[=\s]+["']?([^\s"']+)["']?/i);
  if (!csrfMatch || csrfMatch[1].trim() === '') {
    return null;
  }
  const csrfToken = csrfMatch[1].trim();

  // Extract add-dir / workspace_id
  const addDirMatch = cmd.match(/(?:--add[-_]dir)[=\s]+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  const wsIdMatch = cmd.match(/(?:--workspace[-_]id)[=\s]+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  const rawPath = addDirMatch
    ? addDirMatch[1] ?? addDirMatch[2] ?? addDirMatch[3]
    : wsIdMatch
      ? wsIdMatch[1] ?? wsIdMatch[2] ?? wsIdMatch[3]
      : null;

  let score = 2; // Bare background hub by default
  if (rawPath) {
    if (isPathMatch(rawPath, workspacePaths)) {
      score = 3; // Highest priority: matches open workspace
    } else {
      score = 1; // Explicit other workspace
    }
  }

  return { port, csrfToken, score };
}

/**
 * Parses process listing stdout (Linux/macOS `ps` or Windows `Get-CimInstance` JSON)
 * and returns ranked Antigravity HubEndpoints, deduplicated by `host:port`.
 */
export function parseProcessCandidates(stdout: string, workspacePaths: string[] = []): HubEndpoint[] {
  if (!stdout || typeof stdout !== 'string') {
    return [];
  }

  const trimmed = stdout.trim();
  const commandLines: string[] = [];

  // Try parsing Windows PowerShell JSON output
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && typeof item === 'object') {
          const cmd = item.CommandLine ?? item.commandLine ?? item.CommandLine_ ?? item.cmd;
          if (typeof cmd === 'string' && cmd.trim() !== '') {
            commandLines.push(cmd.trim());
          }
        }
      }
    } catch {
      // If full JSON parse failed, split into lines and parse individual JSON objects
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const l = line.trim();
        if (l.startsWith('{') && l.endsWith('}')) {
          try {
            const item = JSON.parse(l);
            const cmd = item.CommandLine ?? item.commandLine;
            if (typeof cmd === 'string' && cmd.trim() !== '') {
              commandLines.push(cmd.trim());
            }
          } catch {
            commandLines.push(l);
          }
        } else if (l !== '') {
          commandLines.push(l);
        }
      }
    }
  }

  // If not JSON or no JSON command lines found, treat as standard text lines (e.g. ps)
  if (commandLines.length === 0) {
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      const l = line.trim();
      if (l !== '') {
        commandLines.push(l);
      }
    }
  }

  const matches: ProcessMatch[] = [];
  for (const cmd of commandLines) {
    const match = extractCommandLineCandidate(cmd, workspacePaths);
    if (match) {
      matches.push(match);
    }
  }

  // Sort descending by score (matching workspace > bare hub > other workspace)
  matches.sort((a, b) => b.score - a.score);

  // Deduplicate by host:port (keeping highest score)
  const seenPorts = new Set<number>();
  const endpoints: HubEndpoint[] = [];

  for (const m of matches) {
    if (!seenPorts.has(m.port)) {
      seenPorts.add(m.port);
      endpoints.push({
        port: m.port,
        csrfToken: m.csrfToken,
        host: '127.0.0.1',
        source: 'process',
      });
    }
  }

  return endpoints;
}

/**
 * Discovers available `agy --hub` Connect-RPC endpoints across:
 * 1. `google.google-antigravity` extension exports ({ port, csrfToken })
 * 2. Platform process scanner (ps on POSIX, Get-CimInstance on win32)
 * 3. WSL /etc/resolv.conf nameserver fallback candidate when running under WSL
 */
export async function discoverHubEndpoints(deps: HubDiscoveryDeps = {}): Promise<HubEndpoint[]> {
  const endpoints: HubEndpoint[] = [];
  const seenKeys = new Set<string>();

  function addEndpoint(ep: HubEndpoint): void {
    const key = `${ep.host}:${ep.port}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      endpoints.push(ep);
    }
  }

  // 1. Check extension exports
  let rawExports: { port?: number; csrfToken?: string } | null | undefined = deps.extensionExports;
  if (!rawExports && deps.getExtension) {
    try {
      rawExports = deps.getExtension('google.google-antigravity')?.exports;
    } catch {
      // Safe fallback
    }
  }

  if (
    rawExports &&
    typeof rawExports.port === 'number' &&
    rawExports.port > 0 &&
    rawExports.port <= 65535 &&
    typeof rawExports.csrfToken === 'string' &&
    rawExports.csrfToken.trim() !== ''
  ) {
    addEndpoint({
      port: rawExports.port,
      csrfToken: rawExports.csrfToken.trim(),
      host: '127.0.0.1',
      source: 'exports',
    });
  }

  // 2. Platform process scanner
  const platform = deps.platform ?? process.platform;
  const runner = deps.execFileAsync ?? (execFileAsync as (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>);
  const workspacePaths = deps.workspacePaths ?? [];

  try {
    let stdout = '';
    if (platform === 'win32') {
      const res = await runner('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
      ]);
      stdout = res.stdout;
    } else {
      const res = await runner('ps', ['-A', '-ww', '-o', 'pid,ppid,args']);
      stdout = res.stdout;
    }

    const procCandidates = parseProcessCandidates(stdout, workspacePaths);
    for (const cand of procCandidates) {
      addEndpoint(cand);
    }
  } catch {
    // Process scanning failed or command unavailable, proceed with existing endpoints
  }

  // 3. WSL detection & /etc/resolv.conf nameserver fallback
  const isWsl =
    Boolean(deps.env?.WSL_DISTRO_NAME ?? process.env.WSL_DISTRO_NAME) ||
    Boolean(deps.resolvConfText) ||
    Boolean(deps.procVersionText && /microsoft|wsl/i.test(deps.procVersionText));

  let resolvText = deps.resolvConfText;
  if (isWsl && !resolvText) {
    try {
      if (deps.readFile) {
        resolvText = await deps.readFile('/etc/resolv.conf', 'utf8');
      } else {
        resolvText = await fs.readFile('/etc/resolv.conf', 'utf8');
      }
    } catch {
      // /etc/resolv.conf not readable
    }
  }

  if (isWsl && resolvText) {
    const match = resolvText.match(/^\s*nameserver\s+([0-9a-fA-F.:]+)/m);
    const nameserverIp = match ? match[1].trim() : null;
    if (nameserverIp && nameserverIp !== '127.0.0.1') {
      // Append WSL host candidate for any loopback candidate discovered
      const localEndpoints = [...endpoints];
      for (const ep of localEndpoints) {
        if (ep.host === '127.0.0.1') {
          addEndpoint({
            port: ep.port,
            csrfToken: ep.csrfToken,
            host: nameserverIp,
            source: 'wsl-host',
          });
        }
      }
    }
  }

  return endpoints;
}
