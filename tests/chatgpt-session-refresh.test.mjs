// Shared worker behavior is exercised with the real auth and model cores in
// chatgpt-session-runtime.test.mjs; this file checks the public source boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('only the worker imports auth/model implementation; host/client never own core lifecycle', async () => {
  const read = path => readFile(new URL(path, import.meta.url), 'utf8');
  const [client, host, worker, background] = await Promise.all([
    read('../src/services/chatgptPlanClient.ts'), read('../src/session/index.ts'),
    read('../src/session/chatgpt-session.worker.ts'), read('../src/background/chatgptSessionBackground.ts'),
  ]);
  assert.match(worker, /await import\('\.\.\/services\/chatgptPlanAuth'\)/);
  assert.match(worker, /await import\('\.\.\/services\/chatgptPlan'\)/);
  for (const source of [client, host, background]) {
    assert.doesNotMatch(source, /getChatGPTPlanAccessToken|\.terminate\(|closeDocument\(|pagehide/);
    assert.doesNotMatch(source, /storage\.session|localStorage|indexedDB|console\.(?:log|warn|error)/);
  }
  assert.match(host, /new Worker\(/);
  assert.doesNotMatch(worker, /case ['"](?:getAccessToken|token|refresh)['"]/);
});
