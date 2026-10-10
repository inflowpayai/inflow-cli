import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test(
  'macOS native compilation leaves the development module unchanged with an isolated output directory',
  {
    skip: process.platform !== 'darwin',
  },
  () => {
    const developmentPath = resolve('packages/core/native/build/vault_peer_darwin.node');
    const before = readFileSync(developmentPath);
    const workspace = mkdtempSync(join(tmpdir(), 'inflow-native-build-'));
    const outputDirectory = join(workspace, 'native output');
    try {
      execFileSync(process.execPath, ['scripts/build-vault-peer-native.mjs'], {
        env: { ...process.env, INFLOW_VAULT_NATIVE_BUILD_DIR: outputDirectory },
        stdio: 'pipe',
      });
      assert.ok(statSync(join(outputDirectory, 'vault_peer_darwin.node')).size > 0);
      assert.deepEqual(readFileSync(developmentPath), before);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
