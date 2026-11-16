#!/usr/bin/env node
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32 } from 'node:zlib';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function filesUnder(directory, relative = '') {
  const result = [];
  for (const name of (await readdir(path.join(directory, relative))).sort()) {
    const entry = path.join(relative, name);
    const info = await lstat(path.join(directory, entry));
    if (info.isSymbolicLink()) throw new Error('Extension packages must not contain symbolic links.');
    if (info.isDirectory()) result.push(...await filesUnder(directory, entry));
    else if (info.isFile()) result.push(entry.replaceAll('\\', '/'));
  }
  return result;
}

// ZIP32 stored entries: deterministic timestamps, UTF-8 names, no external ZIP dependency.
export function makeZip(entries) {
  if (entries.length > 65535) throw new Error('Too many archive entries.');
  const local = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (!name || name.startsWith('/') || /^[a-z]:/iu.test(name) || name.split('/').includes('..') || name.includes('\\') || name.includes('\0')) throw new Error('Unsafe archive path.');
    const filename = Buffer.from(name, 'utf8');
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x800, 8);
    index.writeUInt16LE(0x21, 14); index.writeUInt32LE(checksum, 16);
    index.writeUInt32LE(data.length, 20); index.writeUInt32LE(data.length, 24); index.writeUInt16LE(filename.length, 28);
    index.writeUInt32LE(offset, 42); central.push(index, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function packageStore({ rootDir = projectRoot, outputDir } = {}) {
  const root = path.resolve(rootDir);
  const dist = path.join(root, 'dist');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.version !== pkg.version) throw new Error('Build and package versions must match and use Manifest V3.');
  for (const required of ['sidepanel.html', 'popup.html', 'options.html', 'background.js']) {
    if (!(await lstat(path.join(dist, required))).isFile()) throw new Error(`Missing entry: ${required}`);
  }
  for (const [size, file] of Object.entries(manifest.icons ?? {})) {
    const iconPath = path.resolve(dist, file);
    if (!iconPath.startsWith(dist + path.sep)) throw new Error('Icon path leaves the build directory.');
    const image = await readFile(iconPath);
    if (image.length < 24 || !image.subarray(0, 8).equals(pngSignature)
      || image.readUInt32BE(16) !== Number(size) || image.readUInt32BE(20) !== Number(size)) throw new Error('Manifest icons must be real PNG files of the declared size.');
  }
  // Chrome Web Store rejects packages whose manifest.json contains "key"; strip it only from the archive copy.
  const { key: _ignoredKey, ...storeManifest } = manifest;
  const entries = [];
  for (const name of await filesUnder(dist)) {
    if (/(^|\/)(?:node_modules|\.pnpm-store|tests|scripts|\.git)(\/|$)|(^|\/)\.env|\.(?:map|pem|key|log)$/iu.test(name)) throw new Error(`Unexpected private/development artifact in build: ${name}`);
    const data = name === 'manifest.json'
      ? Buffer.from(`${JSON.stringify(storeManifest, null, 2)}\n`, 'utf8')
      : await readFile(path.join(dist, name));
    entries.push({ name, data });
  }
  entries.push({ name: 'LICENSE', data: await readFile(path.join(root, 'LICENSE')) });
  const directory = outputDir ? path.resolve(outputDir) : path.join(root, 'artifacts', 'chrome-web-store');
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, `tabflow-${manifest.version}-chrome-web-store.zip`);
  const archive = makeZip(entries);
  await writeFile(filename, archive);
  return { path: filename, version: manifest.version, files: entries.length, bytes: archive.length, publicKeyIncluded: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await packageStore(), null, 2));
}
