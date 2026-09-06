import { promises as fs } from 'node:fs';

const ALLOW_UNUSED_PATCHES = /^allowUnusedPatches:[\t ]*(?:true|false)[\t ]*$/gm;
const BEGIN_MARK = '# >>> link-local-inflow-node:overrides';
const END_MARK = '# <<< link-local-inflow-node:overrides';

export function replaceAllowUnusedPatches(yaml, enabled) {
  const matches = [...yaml.matchAll(ALLOW_UNUSED_PATCHES)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one allowUnusedPatches setting; found ${matches.length}.`);
  }
  return yaml.replace(ALLOW_UNUSED_PATCHES, `allowUnusedPatches: ${enabled}`);
}

export async function setAllowUnusedPatches(workspaceYaml, enabled) {
  const existing = await fs.readFile(workspaceYaml, 'utf-8');
  const next = replaceAllowUnusedPatches(existing, enabled);
  if (next === existing) return false;
  await fs.writeFile(workspaceYaml, next, 'utf-8');
  return true;
}

export function managedOverrides(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line.trim() === BEGIN_MARK);
  if (start === -1) return new Map();
  const end = lines.findIndex((line, index) => index > start && line.trim() === END_MARK);
  if (end === -1) throw new Error(`Missing ${END_MARK}.`);
  const entries = new Map();
  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^\s*'(@[^']+)':\s*(.+)$/);
    if (match !== null) entries.set(match[1], match[2]);
  }
  return entries;
}

export function removeManagedOverrides(yaml) {
  const lines = yaml.split('\n');
  const output = [];
  let managed = false;
  for (const line of lines) {
    if (line.trim() === BEGIN_MARK) {
      if (managed) throw new Error(`Duplicate ${BEGIN_MARK}.`);
      managed = true;
      continue;
    }
    if (line.trim() === END_MARK) {
      if (!managed) throw new Error(`Unexpected ${END_MARK}.`);
      managed = false;
      continue;
    }
    if (!managed) output.push(line);
  }
  if (managed) throw new Error(`Missing ${END_MARK}.`);
  removeEmptyOverridesMapping(output);
  return output.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/u, '\n');
}

export function replaceManagedOverrides(yaml, entries) {
  const stripped = removeManagedOverrides(yaml);
  const lines = stripped.split('\n');
  const headers = lines.flatMap((line, index) => (line === 'overrides:' ? [index] : []));
  if (headers.length > 1) throw new Error(`Expected at most one top-level overrides mapping; found ${headers.length}.`);
  const block = [
    `  ${BEGIN_MARK}`,
    ...entries.map(([name, value]) => `  '${name}': ${value}`),
    `  ${END_MARK}`,
  ];
  if (headers.length === 1) {
    lines.splice(headers[0] + 1, 0, ...block);
  } else {
    while (lines.at(-1) === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push('overrides:', ...block, '');
  }
  return lines.join('\n');
}

function removeEmptyOverridesMapping(lines) {
  const index = lines.findIndex((line) => line === 'overrides:');
  if (index === -1) return;
  let following = index + 1;
  while (following < lines.length && lines[following].trim() === '') following += 1;
  if (following === lines.length || !/^\s/u.test(lines[following])) lines.splice(index, 1);
}
