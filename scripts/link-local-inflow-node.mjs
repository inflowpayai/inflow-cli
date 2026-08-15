#!/usr/bin/env node
/**
 * Redirect local SDK packages from `inflow-node`, `aep-node`, and `odp-node` checkouts via pnpm-workspace.yaml
 * overrides. Use while developing against unpublished SDK changes before the corresponding npm release lands.
 *
 * Reads the target checkouts from `$INFLOW_NODE_PATH`, `$AEP_NODE_PATH`, and `$ODP_NODE_PATH` (all default to sibling
 * checkouts). Bails out if any linked package is missing or unbuilt in its target checkout.
 *
 * Writes to `pnpm-workspace.yaml`'s `overrides:` block — the modern home for workspace-level overrides under pnpm 11+
 * (the legacy `pnpm.overrides` and top-level `overrides` in `package.json` are either ignored or limited to transitive
 * deps).
 *
 * Companion: `scripts/unlink-local-inflow-node.mjs`.
 */
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { setAllowUnusedPatches } from './local-link-workspace.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_YAML = path.join(REPO_ROOT, 'pnpm-workspace.yaml');
const INFLOW_LINKED = ['@inflowpayai/x402', '@inflowpayai/x402-buyer', '@inflowpayai/mpp', '@inflowpayai/mpp-buyer'];
const AEP_LINKED = [
  '@aep-foundation/agent',
  '@aep-foundation/core',
  '@aep-foundation/express',
  '@aep-foundation/platform',
  '@aep-foundation/service',
];
const ODP_LINKED = ['@offering-protocol/agent', '@offering-protocol/core', '@offering-protocol/directory'];
const LINKED = [...INFLOW_LINKED, ...AEP_LINKED, ...ODP_LINKED];
const INFLOW_NODE_AEP_LINKED = ['@aep-foundation/core', '@aep-foundation/express', '@aep-foundation/service'];

const BEGIN_MARK = '# >>> link-local-inflow-node:overrides';
const END_MARK = '# <<< link-local-inflow-node:overrides';

function resolveInflowNodePath() {
  const fromEnv = process.env.INFLOW_NODE_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.resolve(REPO_ROOT, '..', 'inflow-node');
}

function resolveAepNodePath() {
  const fromEnv = process.env.AEP_NODE_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.resolve(REPO_ROOT, '..', '..', 'AEP', 'aep-node');
}

function resolveOdpNodePath() {
  const fromEnv = process.env.ODP_NODE_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.resolve(REPO_ROOT, '..', '..', 'ODP', 'odp-node');
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function assertCheckout(checkoutPath, packages, checkoutName) {
  for (const name of packages) {
    const pkg = path.join(checkoutPath, aepPackageDirectory(name), 'package.json');
    if (!(await fileExists(pkg))) {
      process.stderr.write(
        `link-local-inflow-node: missing ${pkg}. Set ${checkoutName}_PATH or check out ${checkoutName.toLowerCase()} alongside this repo.\n`,
      );
      process.exit(1);
    }
    const dist = path.join(checkoutPath, aepPackageDirectory(name), 'dist', 'index.d.ts');
    if (!(await fileExists(dist))) {
      process.stderr.write(
        `link-local-inflow-node: ${dist} not found. Run \`pnpm --filter ${name} build\` in ${checkoutName.toLowerCase()} first.\n`,
      );
      process.exit(1);
    }
  }
}

function buildOverridesBlock(workspaceRoot, inflowNodePath, aepNodePath, odpNodePath, packages) {
  const lines = [BEGIN_MARK, 'overrides:'];
  for (const name of packages.inflow) {
    const sub = name.split('/')[1];
    const rel = path.relative(workspaceRoot, path.join(inflowNodePath, 'packages', sub));
    lines.push(`  '${name}': link:${rel}`);
  }
  for (const name of packages.aep) {
    const rel = path.relative(workspaceRoot, path.join(aepNodePath, aepPackageDirectory(name)));
    lines.push(`  '${name}': link:${rel}`);
  }
  for (const name of packages.odp) {
    const sub = name.split('/')[1];
    const rel = path.relative(workspaceRoot, path.join(odpNodePath, 'packages', sub));
    lines.push(`  '${name}': link:${rel}`);
  }
  lines.push(END_MARK);
  return lines.join('\n');
}

async function writeOverrides(workspaceRoot, inflowNodePath, aepNodePath, odpNodePath, packages) {
  const workspaceYaml = path.join(workspaceRoot, 'pnpm-workspace.yaml');
  const existing = await fs.readFile(workspaceYaml, 'utf-8');
  const stripped = stripExistingBlock(existing);
  const block = buildOverridesBlock(workspaceRoot, inflowNodePath, aepNodePath, odpNodePath, packages);
  const next = stripped.endsWith('\n') ? `${stripped}${block}\n` : `${stripped}\n${block}\n`;

  if (next !== existing) await fs.writeFile(workspaceYaml, next, 'utf-8');
  return next !== existing;
}

function aepPackageDirectory(name) {
  const sub = name.split('/')[1];
  return sub === 'express' ? path.join('packages', 'adapters', sub) : path.join('packages', sub);
}

function stripExistingBlock(yaml) {
  // Removes both our managed block and any pre-existing `overrides:` line
  // owned by a human edit. We rewrite the block on every run; humans who
  // need other overrides should keep them outside our markers.
  const re = new RegExp(`\\n?${escapeRe(BEGIN_MARK)}[\\s\\S]*?${escapeRe(END_MARK)}\\n?`, 'g');
  return yaml.replace(re, '\n');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clearLocalPackageReferences(workspaceRoot, packages) {
  const packageJson = path.join(workspaceRoot, 'package.json');
  const raw = await fs.readFile(packageJson, 'utf-8');
  const manifest = JSON.parse(raw);
  let mutated = false;
  for (const dependencyKind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = manifest[dependencyKind];
    if (dependencies === undefined) continue;
    for (const name of packages) {
      if (typeof dependencies[name] === 'string' && dependencies[name].startsWith('link:')) {
        delete dependencies[name];
        mutated = true;
      }
    }
    if (Object.keys(dependencies).length === 0) delete manifest[dependencyKind];
  }
  if (manifest.overrides !== undefined) {
    for (const name of packages) {
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
    for (const name of packages) {
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
    await fs.writeFile(packageJson, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
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
const aepNodePath = resolveAepNodePath();
const odpNodePath = resolveOdpNodePath();
await assertCheckout(inflowNodePath, INFLOW_LINKED, 'INFLOW_NODE');
await assertCheckout(aepNodePath, AEP_LINKED, 'AEP_NODE');
await assertCheckout(odpNodePath, ODP_LINKED, 'ODP_NODE');
await clearLocalPackageReferences(REPO_ROOT, LINKED);
await clearLocalPackageReferences(inflowNodePath, INFLOW_NODE_AEP_LINKED);
await setAllowUnusedPatches(WORKSPACE_YAML, true);
const cliChanged = await writeOverrides(REPO_ROOT, inflowNodePath, aepNodePath, odpNodePath, {
  aep: AEP_LINKED,
  inflow: INFLOW_LINKED,
  odp: ODP_LINKED,
});
const inflowNodeChanged = await writeOverrides(inflowNodePath, inflowNodePath, aepNodePath, odpNodePath, {
  aep: AEP_LINKED.filter((name) =>
    ['@aep-foundation/core', '@aep-foundation/express', '@aep-foundation/service'].includes(name),
  ),
  inflow: [],
  odp: [],
});
process.stdout.write(
  `link-local-inflow-node: ${cliChanged || inflowNodeChanged ? 'wrote' : 'kept'} overrides for the CLI and inflow-node workspaces.\n`,
);

await run('pnpm', ['install']);
await run('pnpm', ['install'], { cwd: inflowNodePath });
await run(
  'pnpm',
  [
    'link',
    path.join(aepNodePath, aepPackageDirectory('@aep-foundation/core')),
    path.join(aepNodePath, aepPackageDirectory('@aep-foundation/express')),
    path.join(aepNodePath, aepPackageDirectory('@aep-foundation/service')),
  ],
  { cwd: path.join(inflowNodePath, 'examples', 'mpp-aep-seller-express'), env: { ...process.env, CI: 'true' } },
);
process.stdout.write('link-local-inflow-node: done. Run `scripts/unlink-local-inflow-node.mjs` to revert.\n');
