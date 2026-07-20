export interface UpdateInfo {
  current: string;
  latest: string;
}

export interface UpdateProbeRequest {
  polling: boolean;
}

export type UpdateProbe = (request: UpdateProbeRequest) => Promise<UpdateInfo | undefined>;

const RELEASES_LATEST_URL = 'https://api.github.com/repos/inflowpayai/inflow-cli/releases/latest';
const FRESH_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_TTL_MS = 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  value?: UpdateInfo;
}

interface GitHubLatestRelease {
  name?: unknown;
  tag_name?: unknown;
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/u, '');
}

function compareVersionPart(left: string | undefined, right: string | undefined): number {
  const leftValue = Number.parseInt(left ?? '0', 10);
  const rightValue = Number.parseInt(right ?? '0', 10);
  return Math.sign(leftValue - rightValue);
}

export function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = normalizeVersion(latest).split(/[.-]/u);
  const currentParts = normalizeVersion(current).split(/[.-]/u);
  const length = Math.max(latestParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareVersionPart(latestParts[index], currentParts[index]);
    if (comparison !== 0) return comparison > 0;
  }
  return false;
}

function releaseVersion(release: GitHubLatestRelease): string | undefined {
  const value = typeof release.tag_name === 'string' ? release.tag_name : release.name;
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeVersion(value);
  return normalized.length > 0 ? normalized : undefined;
}

export function makeBackgroundUpdateProbe(
  _packageName: string,
  cliVersion: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): UpdateProbe {
  let cache: CacheEntry | undefined;
  let inflight: Promise<UpdateInfo | undefined> | undefined;

  function writeCache(value: UpdateInfo | undefined, ttlMs: number): void {
    cache = {
      expiresAt: Date.now() + ttlMs,
      ...(value !== undefined ? { value } : {}),
    };
  }

  async function checkUpstreamVersion(): Promise<UpdateInfo | undefined> {
    try {
      const response = await fetchImpl(RELEASES_LATEST_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `inflow/${cliVersion}`,
        },
      });
      if (!response.ok) {
        writeCache(undefined, STALE_TTL_MS);
        return undefined;
      }
      const latest = releaseVersion((await response.json()) as GitHubLatestRelease);
      const value: UpdateInfo | undefined =
        latest !== undefined && isNewerVersion(latest, cliVersion) ? { current: cliVersion, latest } : undefined;
      writeCache(value, FRESH_TTL_MS);
      return value;
    } catch {
      writeCache(undefined, STALE_TTL_MS);
      return undefined;
    }
  }

  return ({ polling }) => {
    if (polling) {
      return Promise.resolve(cache?.value);
    }
    if (cache !== undefined && cache.expiresAt > Date.now()) {
      return Promise.resolve(cache.value);
    }
    if (process.env['NO_UPDATE_NOTIFIER'] !== undefined) {
      return Promise.resolve(undefined);
    }
    if (!inflight) {
      inflight = checkUpstreamVersion().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };
}

export function makeFrozenUpdateProbe(snapshot?: UpdateInfo): UpdateProbe {
  return () => Promise.resolve(snapshot);
}

export function formatUpdateNotice(info: UpdateInfo): string {
  return `A newer InFlow CLI is available: ${info.latest}.\n`;
}
