/**
 * Vitest global setup for the CLI package.
 *
 * Runs BEFORE any test file imports ink / ink-testing-library / cli source, which is the only window in which we can
 * influence module-load-time side effects in those packages.
 *
 * Why this file exists:
 *
 * Ink v5 calls `is-in-ci` (transitively via several dependencies) at module-load time and uses the result to choose
 * between two renderer paths. The CI-mode path appends frames as separate writes with different buffering rules; under
 * ink-testing-library v4 this collapses to a single empty write, and `lastFrame()` returns just '\n'. That breaks every
 * test that asserts on a post-state-transition frame (39 tests across login/logout/status/x402-* on GitHub Actions, all
 * matching the pattern `expected '\n' to contain '...'`).
 *
 * The fix is to neutralize CI detection BEFORE ink loads. Since `is-in-ci` reads process.env lazily on first call but
 * caches the result, deleting the env vars in a vitest setup file (which runs before test imports) is sufficient. We do
 * not need to mock the module.
 *
 * Side effect 2 — stdout dimensions:
 *
 * Ink reads `process.stdout.columns` / `rows` for Yoga layout. GitHub-hosted runners report columns=0 (or undefined),
 * which collapses Box widths and truncates output. Pin sensible defaults so layout is deterministic across
 * environments.
 */

const CI_ENV_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITHUB_WORKFLOW',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'TF_BUILD',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'AZURE_HTTP_USER_AGENT',
  'APPVEYOR',
  'CODEBUILD_BUILD_ID',
  'BUILD_NUMBER',
  'RUN_ID',
];

for (const name of CI_ENV_VARS) {
  delete process.env[name];
}

if (!process.stdout.columns) {
  Object.defineProperty(process.stdout, 'columns', {
    value: 100,
    writable: true,
    configurable: true,
  });
}
if (!process.stdout.rows) {
  Object.defineProperty(process.stdout, 'rows', {
    value: 24,
    writable: true,
    configurable: true,
  });
}
if (!process.stderr.columns) {
  Object.defineProperty(process.stderr, 'columns', {
    value: 100,
    writable: true,
    configurable: true,
  });
}
if (!process.stderr.rows) {
  Object.defineProperty(process.stderr, 'rows', {
    value: 24,
    writable: true,
    configurable: true,
  });
}
