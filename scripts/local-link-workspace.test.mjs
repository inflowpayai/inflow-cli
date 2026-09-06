import assert from 'node:assert/strict';
import test from 'node:test';

import {
  managedOverrides,
  removeManagedOverrides,
  replaceAllowUnusedPatches,
  replaceManagedOverrides,
} from './local-link-workspace.mjs';

test('enables unused patches while local overrides are active', () => {
  const yaml = "packages:\n  - 'packages/*'\n\nallowUnusedPatches: false\n\npatchedDependencies:\n";
  assert.equal(
    replaceAllowUnusedPatches(yaml, true),
    "packages:\n  - 'packages/*'\n\nallowUnusedPatches: true\n\npatchedDependencies:\n",
  );
});

test('disables unused patches after local overrides are removed', () => {
  const yaml = 'allowUnusedPatches: true\n';
  assert.equal(replaceAllowUnusedPatches(yaml, false), 'allowUnusedPatches: false\n');
});

test('rejects a missing or duplicate setting', () => {
  assert.throws(() => replaceAllowUnusedPatches('packages: []\n', true), /found 0/);
  assert.throws(
    () => replaceAllowUnusedPatches('allowUnusedPatches: false\nallowUnusedPatches: true\n', false),
    /found 2/,
  );
});

test('adds managed overrides to an existing mapping', () => {
  const yaml = "packages: []\n\noverrides:\n  esbuild: ^0.28.2\n\npublicHoistPattern: []\n";
  const linked = replaceManagedOverrides(yaml, [['@aep-foundation/core', 'link:../aep-node/packages/core']]);
  assert.match(linked, /overrides:\n  # >>> link-local-inflow-node:overrides\n  '@aep-foundation\/core': link:\.\.\/aep-node\/packages\/core\n  # <<< link-local-inflow-node:overrides\n  esbuild: \^0\.28\.2/);
  assert.equal(removeManagedOverrides(linked), yaml);
});

test('creates and removes a managed overrides mapping', () => {
  const yaml = 'packages: []\n';
  const linked = replaceManagedOverrides(yaml, [['@offering-protocol/core', 'link:../odp-node/packages/core']]);
  assert.deepEqual(managedOverrides(linked), new Map([['@offering-protocol/core', 'link:../odp-node/packages/core']]));
  assert.equal(removeManagedOverrides(linked), yaml);
});

test('replaces the legacy managed overrides block', () => {
  const legacy =
    "packages: []\n\n# >>> link-local-inflow-node:overrides\noverrides:\n  '@aep-foundation/core': link:../old\n# <<< link-local-inflow-node:overrides\n";
  const linked = replaceManagedOverrides(legacy, [['@aep-foundation/core', 'link:../new']]);
  assert.equal(managedOverrides(linked).get('@aep-foundation/core'), 'link:../new');
  assert.equal(linked.match(/^overrides:/gm)?.length, 1);
});
