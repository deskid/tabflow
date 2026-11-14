#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = (await readdir(new URL('../tests/', import.meta.url)))
  .filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `tests/${name}`);
if (!tests.length) throw new Error('No regression tests found.');
const child = spawn(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('Unable to start the regression test runner.'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
