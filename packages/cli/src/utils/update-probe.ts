import process from 'node:process';
import updateNotifier from 'update-notifier';
import { INSTALL_INSTRUCTIONS_URL } from './user-display.js';

export interface UpdateInfo {
  current: string;
  latest: string;
}

export interface UpdateProbeRequest {
  polling: boolean;
}

export type UpdateProbe = (request: UpdateProbeRequest) => Promise<UpdateInfo | undefined>;

const FRESH_TTL_MS = 60 * 60 * 1000;
const STALE_TTL_MS = 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  value?: UpdateInfo;
}

export function makeBackgroundUpdateProbe(packageName: string, cliVersion: string): UpdateProbe {
  let cache: CacheEntry | undefined;
  let inflight: Promise<UpdateInfo | undefined> | undefined;

  function writeCache(value: UpdateInfo | undefined, ttlMs: number): void {
    cache = {
      expiresAt: Date.now() + ttlMs,
      ...(value !== undefined ? { value } : {}),
    };
  }

  async function checkUpstreamVersion(): Promise<UpdateInfo | undefined> {
    const priorFlag = process.env['NO_UPDATE_NOTIFIER'];
    try {
      process.env['NO_UPDATE_NOTIFIER'] = '1';
      const notifier = updateNotifier({
        pkg: { name: packageName, version: cliVersion },
      });
      const payload = await notifier.fetchInfo();
      const latest = payload.latest.trim();
      const value: UpdateInfo | undefined =
        latest.length > 0 && latest !== cliVersion ? { current: cliVersion, latest } : undefined;
      writeCache(value, FRESH_TTL_MS);
      return value;
    } catch {
      writeCache(undefined, STALE_TTL_MS);
      return undefined;
    } finally {
      if (priorFlag === undefined) {
        delete process.env['NO_UPDATE_NOTIFIER'];
      } else {
        process.env['NO_UPDATE_NOTIFIER'] = priorFlag;
      }
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
  return [
    '',
    `Update available for @inflowpayai/inflow: ${info.current} -> ${info.latest}`,
    `Install instructions: ${INSTALL_INSTRUCTIONS_URL}`,
    '',
  ].join('\n');
}
