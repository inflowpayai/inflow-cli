import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = resolve(repoRoot, 'packages/cli');
const smokeDir = mkdtempSync(join(tmpdir(), 'inflow-package-smoke-'));
const installDir = resolve(smokeDir, 'install');

function runCli(binPath, args) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: installDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      INFLOW_API_KEY: '',
      INFLOW_AUTH_FILE: resolve(smokeDir, 'auth.json'),
      INFLOW_BASE_URL: 'http://127.0.0.1:1',
      INFLOW_ENVIRONMENT: 'sandbox',
      NO_UPDATE_NOTIFIER: '1',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`inflow ${args.join(' ')} exited ${String(result.status)}\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

try {
  execFileSync('pnpm', ['pack', '--pack-destination', smokeDir], {
    cwd: packageDir,
    stdio: 'inherit',
  });
  const tarballs = readdirSync(smokeDir).filter((entry) => entry.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`Expected one package tarball, found ${String(tarballs.length)}`);
  }
  const tarball = resolve(smokeDir, tarballs[0]);
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--cache', resolve(smokeDir, 'npm-cache'), '--prefix', installDir, tarball],
    { stdio: 'inherit' },
  );

  const installedPackageDir = resolve(installDir, 'node_modules/@inflowpayai/inflow');
  const manifest = JSON.parse(readFileSync(resolve(installedPackageDir, 'package.json'), 'utf8'));
  const binEntry = typeof manifest.bin === 'object' ? manifest.bin?.inflow : manifest.bin;
  if (typeof binEntry !== 'string') {
    throw new Error('Installed package does not declare the inflow binary');
  }
  const binPath = resolve(installedPackageDir, binEntry);

  const help = runCli(binPath, ['--help']);
  if (!help.includes('--skill')) {
    throw new Error('inflow --help did not include the patched --skill global flag');
  }

  const version = runCli(binPath, ['--version']).trim();
  if (version !== manifest.version) {
    throw new Error(`inflow --version printed ${version}; expected ${manifest.version}`);
  }

  const status = JSON.parse(runCli(binPath, ['auth', 'status', '--format', 'json']));
  const firstFrame = Array.isArray(status) ? status[0] : status;
  if (typeof firstFrame !== 'object' || firstFrame === null || firstFrame.authenticated !== false) {
    throw new Error('inflow auth status did not return an unauthenticated status frame');
  }
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
