#!/usr/bin/env node
// Non-generative verification. Never prints account details, auth or model names.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { frame } from './native-bridge.mjs';
const installDir = process.argv[2] || path.join(process.env.LOCALAPPDATA, 'TabFlowNativeHost');
const manifest = JSON.parse(readFileSync(path.join(installDir, 'com.tabflow.codex_bridge.json'), 'utf8'));
const child = spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `""${manifest.path}""`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true });
let bytes = Buffer.alloc(0); const replies = [];
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; console.error('Native host verification timed out.'); }, 60000);
child.stderr.resume();
child.stdout.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); });
child.on('error', () => { clearTimeout(timer); process.exitCode = 1; console.error('Native host launcher failed to start.'); });
child.on('exit', code => {
  clearTimeout(timer);
  try {
    assert.equal(code, 0, 'Native host exited with an error');
    while (bytes.length >= 4) { const n = bytes.readUInt32LE(0); assert.ok(n < 1024 * 1024); assert.ok(bytes.length >= n + 4); replies.push(JSON.parse(bytes.subarray(4, n + 4))); bytes = bytes.subarray(n + 4); }
    assert.equal(bytes.length, 0); assert.equal(replies.length, 2);
    for (const r of replies) if (!r.success) throw new Error('Native host request failed.');
    assert.equal(replies[0].type, 'PONG'); assert.equal(replies[1].type, 'STATUS');
    const status = replies[1];
    assert.ok(Array.isArray(status.models));
    assert.ok(status.accountError || typeof status.account?.loggedIn === 'boolean');
    const partialCode = field => typeof status[`${field}RpcCode`] === 'number' ? status[`${field}RpcCode`] : /^[A-Z_]+$/.test(status[`${field}ErrorCode`] || '') ? status[`${field}ErrorCode`] : 'BRIDGE_ERROR';
    console.log(JSON.stringify({ ping: true, loggedIn: status.account?.loggedIn ?? null, modelIdCount: status.models.length,
      ...(status.accountError ? { accountErrorCode: partialCode('account') } : {}),
      ...(status.modelsError ? { modelsErrorCode: partialCode('models') } : {}),
    }));
  } catch { process.exitCode = 1; console.error('Native host verification failed.'); }
});
child.stdin.end(Buffer.concat(['PING', 'GET_CODEX_STATUS'].map(action => frame({ action }))));
