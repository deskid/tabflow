#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts', 'store-previews');
await mkdir(output, { recursive: true });
const chrome = process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const environment = {};
const keys = new Set();
for (const [key, value] of Object.entries(process.env)) {
  // Some Windows shells expose both NO_PROXY and no_proxy; child environments must be unique.
  const normalized = process.platform === 'win32' ? key.toUpperCase() : key;
  if (!keys.has(normalized)) { environment[key] = value; keys.add(normalized); }
}
for (const scene of ['tabs', 'settings', 'reading']) {
  const screenshot = path.join(output, `${scene}.png`);
  const dom = await open(path.join(output, `${scene}.html`), 'w');
  const log = await open(path.join(output, `${scene}.log`), 'w');
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(chrome, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-proxy-server',
        '--force-device-scale-factor=2', '--window-size=520,700', '--virtual-time-budget=5000', '--dump-dom',
        `--user-data-dir=${path.join(output, 'chrome-profiles', scene)}`, `--screenshot=${screenshot}`,
        `http://127.0.0.1:43187/demo.html?scene=${scene}`,
      ], { env: environment, stdio: ['ignore', dom.fd, log.fd], windowsHide: true, timeout: 30000 });
      child.once('error', reject); child.once('exit', resolve);
    });
    if (code !== 0) throw new Error(`Headless capture failed: ${scene} (${code})`);
    const html = await readFile(path.join(output, `${scene}.html`), 'utf8');
    if (!html.includes(`data-demo-ready="${scene}"`) || html.includes('data-demo-error=')) throw new Error(`Demo UI did not render cleanly: ${scene}`);
    if (!(await stat(screenshot)).size) throw new Error(`Empty capture: ${scene}`);
    console.log(`Captured real UI with synthetic data: ${scene}`);
  } finally { await dom.close(); await log.close(); }
}
