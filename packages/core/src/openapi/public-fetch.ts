import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch } from 'undici';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function publicDocumentUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (isIP(hostname) !== 0 && !isPublicAddress(hostname))
  ) {
    throw new TypeError('Public documents require an HTTPS URL without credentials or a fragment.');
  }
  return url;
}

export type PublicDocumentFetch = (url: URL, init: RequestInit) => Promise<Response>;

export const fetchPublicDocument: PublicDocumentFetch = (url, init) =>
  fetchPublicRequest(url, { ...init, method: 'GET', body: null });

export const fetchPublicRequest: PublicDocumentFetch = async (url, init) => {
  publicDocumentUrl(url.href);
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true }, (error, addresses) => {
          if (error) {
            callback(error, [], 4);
            return;
          }
          if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
            callback(new Error('Public document DNS resolved to a non-public address.'), [], 4);
            return;
          }
          const first = addresses[0];
          if (first === undefined) return;
          if (options.all) callback(null, addresses);
          else callback(null, first.address, first.family);
        });
      },
    },
  });
  try {
    const response = await fetch(url, {
      dispatcher,
      method: init.method ?? 'GET',
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      redirect: 'manual',
      credentials: 'omit',
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
    // The dispatcher remains alive until the bounded reader consumes or cancels the body.
    const reader = response.body?.getReader();
    let cancelled = false;
    const body =
      reader === undefined
        ? null
        : new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const result = await reader.read();
                if (cancelled) return;
                if (result.done) {
                  controller.close();
                  await dispatcher.close();
                } else {
                  const bytes: unknown = result.value;
                  if (!(bytes instanceof Uint8Array)) throw new TypeError('Public document stream is not bytes.');
                  controller.enqueue(bytes);
                }
              } catch (error) {
                controller.error(error);
                await dispatcher.destroy();
              }
            },
            async cancel() {
              cancelled = true;
              await reader.cancel();
              await dispatcher.destroy();
            },
          });
    if (body === null) await dispatcher.close();
    return new Response(body, { status: response.status, headers: Object.fromEntries(response.headers) });
  } catch (error) {
    await dispatcher.destroy();
    throw error;
  }
};
