import { promises as fs } from 'node:fs';

const ALLOW_UNUSED_PATCHES = /^allowUnusedPatches:[\t ]*(?:true|false)[\t ]*$/gm;

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
