#!/usr/bin/env node
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const output = resolve(process.argv[2] ?? 'dist/native/assets');
const inputs = process.argv.slice(3).map((path) => resolve(path));
if (inputs.length === 0) throw new Error('At least one native release staging directory is required.');

const files = inputs.flatMap((root) => walk(root)).filter((path) => basename(path) !== 'inflow.rb');
const byName = new Map();
for (const path of files) {
  const name = basename(path);
  const matches = byName.get(name) ?? [];
  matches.push(path);
  byName.set(name, matches);
}
const duplicates = [...byName.entries()]
  .filter(([, paths]) => paths.length > 1)
  .map(([name]) => name)
  .sort();
if (duplicates.length > 0) throw new Error(`Duplicate native release assets: ${duplicates.join(', ')}`);

mkdirSync(output, { recursive: true });
const existing = readdirSync(output);
if (existing.length > 0) throw new Error(`Native release output directory is not empty: ${output}`);
for (const [name, [source]] of byName) copyFileSync(source, join(output, name));

process.stdout.write(`Assembled ${files.length} native release assets.\n`);

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
