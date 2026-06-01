#!/usr/bin/env node
/**
 * Redirect the local SDK buyer packages (`@inflowpayai/x402`,
 * `@inflowpayai/x402-buyer`, `@inflowpayai/mpp`, `@inflowpayai/mpp-buyer`)
 * to a local `inflow-node` checkout via pnpm-workspace.yaml overrides. Use
 * while developing against unpublished SDK changes before the corresponding
 * npm release lands.
 *
 * Reads the target checkout from `$INFLOW_NODE_PATH` (defaults to
 * `../inflow-node` resolved against this repo's root). Bails out if any
 * linked package is missing or unbuilt in the target checkout.
 *
 * Writes to `pnpm-workspace.yaml`'s `overrides:` block — the modern home
 * for workspace-level overrides under pnpm 11+ (the legacy
 * `pnpm.overrides` and top-level `overrides` in `package.json` are
 * either ignored or limited to transitive deps).
 *
 * Companion: `scripts/unlink-local-inflow-node.mjs`.
 */
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PKG_JSON = path.join(REPO_ROOT, 'package.json');
const WORKSPACE_YAML = path.join(REPO_ROOT, 'pnpm-workspace.yaml');
const LINKED = ['@inflowpayai/x402', '@inflowpayai/x402-buyer', '@inflowpayai/mpp', '@inflowpayai/mpp-buyer'];

const BEGIN_MARK = '# >>> link-local-inflow-node:overrides';
const END_MARK = '# <<< link-local-inflow-node:overrides';

function resolveInflowNodePath() {
  const fromEnv = process.env.INFLOW_NODE_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.resolve(REPO_ROOT, '..', 'inflow-node');
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function assertCheckout(inflowNodePath) {
  for (const name of LINKED) {
    const sub = name.split('/')[1];
    const pkg = path.join(inflowNodePath, 'packages', sub, 'package.json');
    if (!(await fileExists(pkg))) {
      process.stderr.write(
        `link-local-inflow-node: missing ${pkg}. Set INFLOW_NODE_PATH or check out inflow-node alongside this repo.\n`,
      );
      process.exit(1);
    }
    const dist = path.join(inflowNodePath, 'packages', sub, 'dist', 'index.d.ts');
    if (!(await fileExists(dist))) {
      process.stderr.write(
        `link-local-inflow-node: ${dist} not found. Run \`pnpm --filter ${name} build\` in inflow-node first.\n`,
      );
      process.exit(1);
    }
  }
}

function buildOverridesBlock(inflowNodePath) {
  const lines = [BEGIN_MARK, 'overrides:'];
  for (const name of LINKED) {
    const sub = name.split('/')[1];
    const rel = path.relative(REPO_ROOT, path.join(inflowNodePath, 'packages', sub));
    lines.push(`  '${name}': link:${rel}`);
  }
  lines.push(END_MARK);
  return lines.join('\n');
}

function stripExistingBlock(yaml) {
  // Removes both our managed block and any pre-existing `overrides:` line
  // owned by a human edit. We rewrite the block on every run; humans who
  // need other overrides should keep them outside our markers.
  const re = new RegExp(
    `\\n?${escapeRe(BEGIN_MARK)}[\\s\\S]*?${escapeRe(END_MARK)}\\n?`,
    'g',
  );
  return yaml.replace(re, '\n');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clearLegacyOverridesFromPackageJson() {
  const raw = await fs.readFile(ROOT_PKG_JSON, 'utf-8');
  const manifest = JSON.parse(raw);
  let mutated = false;
  if (manifest.overrides !== undefined) {
    for (const name of LINKED) {
      if (manifest.overrides[name] !== undefined) {
        delete manifest.overrides[name];
        mutated = true;
      }
    }
    if (Object.keys(manifest.overrides).length === 0) {
      delete manifest.overrides;
    }
  }
  if (manifest.pnpm?.overrides !== undefined) {
    for (const name of LINKED) {
      if (manifest.pnpm.overrides[name] !== undefined) {
        delete manifest.pnpm.overrides[name];
        mutated = true;
      }
    }
    if (Object.keys(manifest.pnpm.overrides).length === 0) {
      delete manifest.pnpm.overrides;
      if (Object.keys(manifest.pnpm).length === 0) delete manifest.pnpm;
    }
  }
  if (mutated) {
    await fs.writeFile(
      ROOT_PKG_JSON,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf-8',
    );
  }
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

const inflowNodePath = resolveInflowNodePath();
await assertCheckout(inflowNodePath);
await clearLegacyOverridesFromPackageJson();

const existing = await fs.readFile(WORKSPACE_YAML, 'utf-8');
const stripped = stripExistingBlock(existing);
const block = buildOverridesBlock(inflowNodePath);
const next = stripped.endsWith('\n')
  ? `${stripped}${block}\n`
  : `${stripped}\n${block}\n`;

if (next !== existing) {
  await fs.writeFile(WORKSPACE_YAML, next, 'utf-8');
  process.stdout.write(
    `link-local-inflow-node: wrote pnpm-workspace.yaml overrides → ${LINKED.join(', ')} (target: ${inflowNodePath}).\n`,
  );
} else {
  process.stdout.write('link-local-inflow-node: overrides already current; running install.\n');
}

await run('pnpm', ['install']);
process.stdout.write('link-local-inflow-node: done. Run `scripts/unlink-local-inflow-node.mjs` to revert.\n');
