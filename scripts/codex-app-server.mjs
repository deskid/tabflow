import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

export class BridgeError extends Error {
  constructor(code, message, { rpcCode, method } = {}) {
    super(message); this.code = code;
    if (typeof rpcCode === 'number' && Number.isFinite(rpcCode)) this.rpcCode = rpcCode;
    if (typeof method === 'string') this.method = method;
  }
}
export function resolveCodex(env = process.env) {
  if (env.TABFLOW_CODEX_EXECUTABLE) {
    if (!path.isAbsolute(env.TABFLOW_CODEX_EXECUTABLE) || !existsSync(env.TABFLOW_CODEX_EXECUTABLE))
      throw new BridgeError('CODEX_NOT_FOUND', 'Configured Codex executable does not exist. Run install-native-host.ps1 again.');
    return { command: env.TABFLOW_CODEX_EXECUTABLE, args: [] };
  }
  const npmRoot = path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const triple = arch === 'arm64' ? 'aarch64' : 'x86_64';
  const exe = path.join(npmRoot, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', `${triple}-pc-windows-msvc`, 'bin', 'codex.exe');
  if (process.platform === 'win32' && existsSync(exe)) return { command: exe, args: [] };
  const cli = env.TABFLOW_CODEX_CLI || path.join(npmRoot, 'bin', 'codex.js');
  if (path.isAbsolute(cli) && existsSync(cli)) return { command: process.execPath, args: [cli] };
  throw new BridgeError('CODEX_NOT_FOUND', 'Official Codex CLI was not found. Install it and rerun install-native-host.ps1.');
}

// Disable local execution and integrations before any thread is created. Auth remains
// managed exclusively by the official server (including keyring and CODEX_HOME).
export const SAFE_CONFIG = {
  'features.shell_tool': false, 'features.unified_exec': false,
  'features.apps': false, 'features.plugins': false, 'features.hooks': false,
  'features.multi_agent': false, 'features.multi_agent_v2': false,
  'features.browser_use': false, 'features.computer_use': false,
  'features.image_generation': false, 'features.view_image': false,
  'features.code_mode': false, 'features.code_mode_host': false,
  'features.sleep_tool': false, 'features.memories': false,
  'tools.update_plan.enabled': false, 'web_search': 'disabled',
  'project_doc_max_bytes': 0,
};

export class AppServer extends EventEmitter {
  constructor({ launch = resolveCodex(), env = process.env, timeoutMs = 20000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); this.nextId = 1; this.buffer = ''; this.closed = false;
    const overrides = Object.entries(SAFE_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
    this.child = spawn(launch.command, [...launch.args, 'app-server', '--stdio', ...overrides], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
    });
    // Never forward stderr: upstream diagnostics may contain account/config details.
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.on('error', () => this.fail(new BridgeError('CODEX_START_FAILED', 'Unable to start official Codex app-server. Check its installation.')));
    this.child.on('exit', () => this.fail(new BridgeError('CODEX_EXITED', 'Codex app-server exited before completing the request. Check Codex configuration and login.')));
    this.child.stdin.on('error', () => this.fail(new BridgeError('CODEX_PIPE_FAILED', 'Codex app-server input pipe closed.')));
  }
  fail(error) {
    this.failure = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('failure', error);
  }
  send(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
      this.fail(new BridgeError('CODEX_PROTOCOL_ERROR', 'Codex response exceeded the protocol limit.')); this.close(); return;
    }
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        this.fail(new BridgeError('CODEX_PROTOCOL_ERROR', 'Codex returned invalid JSON-RPC.')); this.close(); return;
      }
      if (msg.method && msg.id !== undefined) {
        // No server-requested command, tool, permission or elicitation is authorized.
        this.send({ id: msg.id, error: { code: -32601, message: 'TabFlow does not permit tool execution or interactive requests.' } });
        this.emit('toolRejected');
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id); if (!p) continue;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) {
          // Copy only locally known method and numeric code, never upstream message/data.
          const rpcCode = typeof msg.error.code === 'number' && Number.isFinite(msg.error.code) ? msg.error.code : undefined;
          const description = p.method === 'account/read' ? '账号状态读取失败，点击刷新重试' : p.method === 'model/list' ? '模型列表读取失败，点击刷新重试' : 'Codex 请求失败，请重试';
          p.reject(new BridgeError('CODEX_RPC_ERROR', `${description}（RPC ${rpcCode ?? '未知'}）。`, { rpcCode, method: p.method }));
        }
        else p.resolve(msg.result);
      } else if (msg.method) this.emit('notification', msg);
    }
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('CODEX_TIMEOUT', `Codex ${method} timed out.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); } catch (e) {
        clearTimeout(timer); this.pending.delete(id); reject(e);
      }
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'tabflow_native_bridge', version: '2.0.0' } });
    this.send({ method: 'initialized', params: {} });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.child.stdin.end(); this.child.kill();
  }
}

export async function readAccount(client) {
  let result;
  try {
    result = await client.request('account/read', { refreshToken: false });
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== 'CODEX_RPC_ERROR' || error.method !== 'account/read' || error.rpcCode !== -32603) throw error;
    await new Promise(resolve => setTimeout(resolve, 100));
    result = await client.request('account/read', { refreshToken: false });
  }
  if (!result || typeof result.requiresOpenaiAuth !== 'boolean' || (result.account !== null && (typeof result.account !== 'object' || Array.isArray(result.account))))
    throw new BridgeError('CODEX_PROTOCOL_ERROR', '账号状态读取失败，点击刷新重试（账号状态格式无效）。');
  return {
    loggedIn: result.account != null,
    ...(typeof result.account?.type === 'string' ? { authMode: result.account.type } : {}),
    requiresOpenaiAuth: result.requiresOpenaiAuth,
  };
}
export async function listModels(client) {
  const models = []; const cursors = new Set(); let cursor;
  do {
    const page = await client.request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data)) throw new BridgeError('CODEX_PROTOCOL_ERROR', 'Codex model/list returned an invalid catalog.');
    for (const m of page.data) {
      if (typeof m.model !== 'string' || !m.model) throw new BridgeError('CODEX_PROTOCOL_ERROR', 'Codex catalog omitted a selectable model identifier.');
      if (!models.some(existing => existing.id === m.model)) models.push({ id: m.model, name: m.displayName || m.model, isDefault: m.isDefault === true });
    }
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new BridgeError('CODEX_PROTOCOL_ERROR', 'Codex model pagination did not terminate.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (!models.length) throw new BridgeError('NO_MODELS', 'Codex returned no available models. Check login and provider configuration.');
  return models;
}
