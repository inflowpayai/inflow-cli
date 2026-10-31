import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const platforms = ['linux', 'macos', 'windows'];
const platformPaths = {
  linux: [
    /^packaging\/linux\//,
    /^\.github\/workflows\/linux-release\.yml$/,
    /^scripts\/[^/]*\blinux\b[^/]*$/,
    /^packages\/core\/(?:native|test\/native)\/[^/]*[_-]linux[_.-]/,
  ],
  macos: [
    /^packaging\/macos\//,
    /^\.github\/workflows\/macos-release\.yml$/,
    /^scripts\/[^/]*\b(?:macos|homebrew)\b[^/]*$/,
    /^packages\/core\/(?:native|test\/native)\/[^/]*[_-]darwin[_.-]/,
  ],
  windows: [
    /^packaging\/windows\//,
    /^\.github\/workflows\/windows-release\.yml$/,
    /^scripts\/[^/]*\b(?:windows|winget)\b[^/]*$/,
    /^packages\/core\/(?:native|test\/native)\/[^/]*[_-]windows[_.-]/,
    /^packages\/core\/(?:src|test\/unit)\/secure-storage\/vault-windows-/,
  ],
};

const verificationOnlyPaths = [
  /\.md$/,
  /^skills\//,
  /^scripts\/(?:align-skill-version\.js|check-changed-coverage(?:\.test)?\.mjs|check-no-build-artifacts\.mjs|configure-github-release-secrets\.example\.sh|(?:un)?link-local-inflow-node\.mjs|local-link-workspace(?:\.test)?\.mjs|mpp-conformance\.mjs|stage-web\.mjs)$/,
  /^packages\/cli\/test\/integration\/aep-/,
];

const sharedPaths = [
  /^(?:\.github\/workflows\/|packaging\/|patches\/|scripts\/)/,
  /^packages\/core\/(?:native\/|src\/secure-storage\/|test\/native\/|test\/unit\/secure-storage\/)/,
  /^packages\/cli\/(?:src\/(?:commands\/vault\/|startup-vault\.ts$|mcp-metadata\.ts$)|test\/integration\/)/,
  /^(?:packages\/[^/]+\/)?(?:package\.json|tsconfig[^/]*\.json|tsup[^/]*\.ts|vitest[^/]*\.ts)$/,
  /^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|\.node-version|\.npmrc|packages\/cli\/src\/cli\.tsx|packages\/cli\/test\/setup\.ts|packages\/core\/src\/(?:index\.ts|utils\/storage\.ts))$/,
];

export function selectPlatforms(paths) {
  const selected = { linux: false, macos: false, windows: false };
  for (const path of paths) {
    if (verificationOnlyPaths.some((pattern) => pattern.test(path))) continue;
    if (path === 'packaging/hosted/install.sh') {
      selected.linux = true;
      selected.macos = true;
      continue;
    }
    const matches = platforms.filter((platform) => platformPaths[platform].some((pattern) => pattern.test(path)));
    if (matches.length > 0) {
      for (const platform of matches) selected[platform] = true;
    } else if (sharedPaths.some((pattern) => pattern.test(path))) {
      for (const platform of platforms) selected[platform] = true;
    }
  }
  return selected;
}

export function detectPlatforms({ base, head, event, cwd = process.cwd() }) {
  if (!base || /^0+$/.test(base) || !head) return { linux: true, macos: true, windows: true };
  try {
    const range = event === 'pull_request' ? `${base}...${head}` : `${base}..${head}`;
    const paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\0')
      .filter(Boolean);
    return selectPlatforms(paths);
  } catch {
    process.stderr.write('Unable to compare revisions; selecting all platform checks.\n');
    return { linux: true, macos: true, windows: true };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const selected = detectPlatforms({
    base: process.env.BASE_SHA,
    head: process.env.HEAD_SHA,
    event: process.env.GITHUB_EVENT_NAME,
  });
  const output = platforms.map((platform) => `${platform}=${selected[platform]}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
