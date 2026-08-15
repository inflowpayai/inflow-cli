import assert from 'node:assert/strict';
import test from 'node:test';

import { replaceAllowUnusedPatches } from './local-link-workspace.mjs';

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
