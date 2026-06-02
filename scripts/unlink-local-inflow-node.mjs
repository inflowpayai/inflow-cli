#!/usr/bin/env node
/**
 * Revert the local-inflow-node overrides written by `link-local-inflow-node.mjs`.
 *
 * Asymmetry worth understanding: `link` redirects all four buyer-side SDK
 * packages to a local `inflow-node` checkout, but only some of them are
 * published to npm. `unlink` can only revert a package to the registry if a
 * registry version actually exists — so it reverts the PUBLISHED packages and
 * deliberately KEEPS the UNPUBLISHED ones linked. Removing an unpublished
 * package's override would leave an unresolvable spec and make `pnpm install`
 * fail with ERR_PNPM_FETCH_404.
 *
 * When an UNPUBLISHED package later ships to npm, move it from `UNPUBLISHED`
 * to `PUBLISHED` below and `unlink` will start reverting it too.
 *
 * Also scrubs stray override entries in `package.json` (top-level `overrides` or `pnpm.overrides`) if present.
 */
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PKG_JSON = path.join(REPO_ROOT, 'package.json');
const WORKSPACE_YAML = path.join(REPO_ROOT, 'pnpm-workspace.yaml');

// Packages that exist on npm and therefore have a registry version to revert to.
const PUBLISHED = [
  '@inflowpayai/x402',
  '@inflowpayai/x402-buyer',
  '@inflowpayai/mpp',
  '@inflowpayai/mpp-buyer',
];
// Packages not yet on npm — only resolvable via the local link, so `unlink` keeps them linked.
const UNPUBLISHED = [];
const LINKED = [...PUBLISHED, ...UNPUBLISHED];

const BEGIN_MARK = '# >>> link-local-inflow-node:overrides';
const END_MARK = '# <<< link-local-inflow-node:overrides';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, ...opts });
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} ${args.join(' ')} exited ${code ?? 'null'}`));
    });
    child.on('error', reject);
  });
}

/**
 * Rewrite the managed overrides block, dropping entries for PUBLISHED packages
 * (reverted to registry) while preserving entries for UNPUBLISHED packages
 * (kept linked). Removes the block entirely when nothing is left to keep.
 */
async function revertWorkspaceYaml() {
  const existing = await fs.readFile(WORKSPACE_YAML, 'utf-8');
  const blockRe = new RegExp(`\\n?${escapeRe(BEGIN_MARK)}([\\s\\S]*?)${escapeRe(END_MARK)}\\n?`);
  const match = existing.match(blockRe);
  if (match === null) {
    return { changed: false, reverted: [], kept: [] };
  }

  const reverted = [];
  const keptLines = [];
  const kept = [];
  for (const line of match[1].split('\n')) {
    const entry = line.match(/^\s*'(@[^']+)':/);
    if (entry === null) continue; // skip the `overrides:` header and blank lines
    const name = entry[1];
    if (UNPUBLISHED.includes(name)) {
      keptLines.push(`  ${line.trim()}`);
      kept.push(name);
    } else {
      reverted.push(name);
    }
  }

  const replacement =
    keptLines.length > 0 ? `\n${[BEGIN_MARK, 'overrides:', ...keptLines, END_MARK].join('\n')}\n` : '\n';
  const next = existing.replace(blockRe, replacement).replace(/\n{3,}/g, '\n\n');

  if (next !== existing) {
    await fs.writeFile(WORKSPACE_YAML, next, 'utf-8');
    return { changed: true, reverted, kept };
  }
  return { changed: false, reverted, kept };
}

async function stripFromPackageJson() {
  const raw = await fs.readFile(ROOT_PKG_JSON, 'utf-8');
  const manifest = JSON.parse(raw);
  let mutated = false;
  for (const branch of ['overrides', 'pnpm']) {
    const overridesObj = branch === 'overrides' ? manifest.overrides : manifest.pnpm?.overrides;
    if (overridesObj === undefined) continue;
    for (const name of PUBLISHED) {
      if (overridesObj[name] !== undefined) {
        delete overridesObj[name];
        mutated = true;
      }
    }
    if (Object.keys(overridesObj).length === 0) {
      if (branch === 'overrides') {
        delete manifest.overrides;
      } else {
        delete manifest.pnpm.overrides;
        if (Object.keys(manifest.pnpm).length === 0) delete manifest.pnpm;
      }
    }
  }
  if (mutated) {
    await fs.writeFile(ROOT_PKG_JSON, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  }
  return mutated;
}

const { changed: yamlChanged, reverted, kept } = await revertWorkspaceYaml();
const pkgChanged = await stripFromPackageJson();

if (!yamlChanged && !pkgChanged) {
  process.stdout.write('unlink-local-inflow-node: no published-package link overrides present; nothing to revert.\n');
} else {
  process.stdout.write(
    `unlink-local-inflow-node: reverted ${reverted.length > 0 ? reverted.join(', ') : '(none)'} to the registry.\n`,
  );
}
if (kept.length > 0) {
  process.stdout.write(
    `unlink-local-inflow-node: kept ${kept.join(', ')} linked — not yet published to npm (see UNPUBLISHED in this script).\n`,
  );
}

await run('pnpm', ['install']);
process.stdout.write('unlink-local-inflow-node: done.\n');
