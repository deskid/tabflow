import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { packageStore, makeZip } from '../scripts/package-store.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tabflow-extension-test-'));
  await mkdir(path.join(root, 'dist', 'icons'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.1.0' }));
  await writeFile(path.join(root, 'LICENSE'), 'ISC test fixture');
  await writeFile(path.join(root, 'dist', 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '1.1.0', key: 'development-public-key', permissions: ['tabs'], icons: { 128: 'icons/icon128.png' } }));
  for (const file of ['sidepanel.html', 'popup.html', 'options.html', 'background.js']) await writeFile(path.join(root, 'dist', file), 'test runtime entry');
  await writeFile(path.join(root, 'dist', 'icons', 'icon128.png'), await readFile(new URL('../public/icons/icon128.png', import.meta.url)));
  return root;
}
function unzipStored(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0);
    const length = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const content = buffer.subarray(start, start + length);
    assert.equal(crc32(content), buffer.readUInt32LE(offset + 14));
    files.set(name, content);
    offset = start + length;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  assert.equal(buffer.readUInt16LE(buffer.length - 12), files.size);
  return files;
}

test('store ZIP is valid, preserves the built manifest and public key, and leaves source unchanged', async () => {
  const root = await fixture();
  try {
    const result = await packageStore({ rootDir: root });
    const files = unzipStored(await readFile(result.path));
    assert.equal(files.size, 7);
    assert.ok(files.has('manifest.json'));
    assert.ok(files.has('LICENSE'));
    const manifest = JSON.parse(files.get('manifest.json'));
    assert.equal(manifest.key, 'development-public-key');
    assert.equal(result.publicKeyIncluded, true);
    assert.equal(result.path, path.join(root, 'artifacts', 'chrome-web-store', 'tabflow-1.1.0-chrome-web-store.zip'));
    assert.deepEqual(files.get('manifest.json'), await readFile(path.join(root, 'dist', 'manifest.json')));
    assert.deepEqual(manifest.permissions, ['tabs']);
    assert.equal(JSON.parse(await readFile(path.join(root, 'dist', 'manifest.json'))).key, 'development-public-key');
    assert.ok([...files.keys()].every((name) => !name.startsWith('dist/')));
    assert.deepEqual(await readFile(result.path), await readFile((await packageStore({ rootDir: root })).path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packaging an optional-key manifest does not invent an extension identity', async () => {
  const root = await fixture();
  try {
    const file = path.join(root, 'dist', 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    delete manifest.key;
    await writeFile(file, JSON.stringify(manifest));
    const result = await packageStore({ rootDir: root });
    const files = unzipStored(await readFile(result.path));
    assert.equal(result.publicKeyIncluded, false);
    assert.deepEqual(files.get('manifest.json'), await readFile(file));
    assert.equal(JSON.parse(files.get('manifest.json')).key, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unexpected environment files and source maps cannot enter an extension ZIP', async () => {
  for (const name of ['.env', 'source.js.map']) {
    const root = await fixture();
    try {
      await writeFile(path.join(root, 'dist', name), 'synthetic private fixture');
      await assert.rejects(packageStore({ rootDir: root }), /Unexpected private\/development artifact/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('extension packaging rejects a stale version and a WebP file named PNG', async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }));
    await assert.rejects(packageStore({ rootDir: root }), /versions must match/);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.1.0' }));
    await writeFile(path.join(root, 'dist', 'icons', 'icon128.png'), Buffer.from('RIFFxxxxxxxxWEBPxxxxxxxxxxxxxxxx'));
    await assert.rejects(packageStore({ rootDir: root }), /real PNG/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('extension packaging refuses directory links to files outside the build', async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, 'outside'));
    await symlink(path.join(root, 'outside'), path.join(root, 'dist', 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(packageStore({ rootDir: root }), /symbolic links/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ZIP writer refuses traversal and absolute entry names', () => {
  for (const name of ['../outside', '/outside', 'C:/outside', 'folder/../outside', 'folder\\outside', 'null\0name']) {
    assert.throws(() => makeZip([{ name, data: Buffer.from('fixture') }]), /Unsafe archive path/);
  }
});
