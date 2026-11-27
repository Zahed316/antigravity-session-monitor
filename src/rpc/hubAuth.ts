import http from 'node:http';
import type { HubEndpoint } from './hubDiscovery.ts';

type ExecFileAsyncFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface HubAuthVscodeApi {
  commands: {
    executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
  };
}

interface AuthRpcResult {
  statusCode: number;
  data: any;
}

/**
 * Minimal Connect-RPC poster for auth endpoints. Kept separate from HubClient so
 * auth can talk to daemon-file endpoints without carrying quota circuit-breaker state.
 */
export class HubAuthClient {
  private readonly timeoutMs: number;
  private readonly postRpcImpl: (
    endpoint: HubEndpoint,
    methodPath: string,
    payload: unknown,
  ) => Promise<AuthRpcResult | null>;

  constructor(
    options: { timeoutMs?: number; postRpc?: (endpoint: HubEndpoint, methodPath: string, payload: unknown) => Promise<AuthRpcResult | null> } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.postRpcImpl = options.postRpc ?? ((endpoint, methodPath, payload) => this.postRpcHttp(endpoint, methodPath, payload));
  }

  /**
   * Minimal HTTP POST to the hub Connect endpoint (http first, https fallback via httpsPort).
   */
  private postRpcHttp(
    endpoint: HubEndpoint,
    methodPath: string,
    payload: unknown,
  ): Promise<AuthRpcResult | null> {
    return new Promise((resolve) => {
      const body = JSON.stringify(payload);
      const req = http.request(
        {
          protocol: 'http:',
          hostname: endpoint.host,
          port: endpoint.port,
          path: `/exa.language_server_pb.LanguageServerService/${methodPath}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': endpoint.csrfToken,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = null;
            if (text.trim().length > 0) {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = text;
              }
            }
            resolve({ statusCode: res.statusCode ?? 0, data: parsed });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`auth RPC timed out after ${this.timeoutMs}ms`)));
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  }

  /**
   * Returns `{ authed }` from GetAuthStatus, or null when unreachable.
   */
  async getAuthStatus(endpoint: HubEndpoint): Promise<{ authed: boolean } | null> {
    const res = await this.postRpcImpl(endpoint, 'GetAuthStatus', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
    });
    if (!res || res.statusCode !== 200 || !res.data || typeof res.data !== 'object') {
      return null;
    }
    const data = res.data as Record<string, unknown>;
    const authed =
      typeof data.authed === 'boolean'
        ? data.authed
        : typeof data.authenticated === 'boolean'
          ? data.authenticated
          : false;
    return { authed };
  }

  /**
   * Attempts official `Login` RPC; on hub-mode refusal falls back to `antigravity.login`
   * in the official Antigravity extension via VS Code commands.
   */
  async login(endpoint: HubEndpoint, vscodeApi?: HubAuthVscodeApi): Promise<boolean> {
    const res = await this.postRpcImpl(endpoint, 'Login', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
    });

    if (res && res.statusCode === 200) {
      return true;
    }

    const message = String((res?.data as Record<string, unknown> | undefined)?.message ?? '');
    if (/only supported in antigravity-hub mode/i.test(message) && vscodeApi) {
      try {
        await vscodeApi.commands.executeCommand('antigravity.login');
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Logs out via AuthLogout RPC. Returns false when unreachable or refused.
   */
  async logout(endpoint: HubEndpoint): Promise<boolean> {
    const res = await this.postRpcImpl(endpoint, 'AuthLogout', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
    });
    return res !== null && res.statusCode === 200;
  }

  /**
   * Asks the official Antigravity extension to refresh auth state, trying each known
   * command in order until one reports success. Returns true when one fired.
   */
  async syncOfficialUi(vscodeApi: HubAuthVscodeApi): Promise<boolean> {
    const commands = [
      'antigravity.handleAuthRefresh',
      'antigravity.reconnect',
      'antigravity.triggerUpdate',
      'antigravity.connectHub',
    ];
    for (const cmd of commands) {
      try {
        const result = await vscodeApi.commands.executeCommand(cmd);
        if (result === true) {
          return true;
        }
      } catch {
        // Command missing in this extension version: try the next one
      }
    }
    return false;
  }

  /**
   * Kills the backend process (pid) so the daemon restarts and re-reads auth state.
   * Returns false when no execFileAsync available or the kill failed.
   */
  async restartBackendProcess(pid: number, execFileAsync?: ExecFileAsyncFn): Promise<boolean> {
    if (!execFileAsync || !Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      await execFileAsync('kill', [String(pid)]);
      return true;
    } catch {
      return false;
    }
  }
}
