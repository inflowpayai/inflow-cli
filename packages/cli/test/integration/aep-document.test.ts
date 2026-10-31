import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'incur';
import vector from '../fixtures/aep-portable-presentation.json' with { type: 'json' };

const execute = promisify(execFile);
const binary = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

type McpResponse = {
  error?: unknown;
  result: {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text: string }[];
    tools?: { name: string; outputSchema?: z.core.JSONSchema.BaseSchema }[];
  };
};

it('preserves discovery HTTP failures through the built CLI and cached SDK path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'inflow-inspect-test-'));
  let status = 404;
  const server = createServer((_request, response) => {
    response.statusCode = status;
    response.end('private diagnostic body');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing fixture port');
    const origin = `http://127.0.0.1:${address.port}`;
    const run = () =>
      execute(process.execPath, [binary, 'aep', 'inspect', origin, '--format', 'json', '--api-base-url', origin], {
        env: { HOME: home, PATH: process.env['PATH'], NO_UPDATE_NOTIFIER: '1' },
        timeout: 10_000,
      });
    const missing = await run();
    expect(JSON.parse(missing.stdout)).toMatchObject({ outcome: 'not-advertised', status: 404 });
    expect(missing.stderr).toBe('');
    status = 503;
    const failure: unknown = await run().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    if (!(failure instanceof Error) || !('stdout' in failure)) throw new Error('Missing command failure');
    expect(failure.stdout).toContain(`AEP Inspect failed at ${origin}/.well-known/aep (HTTP 503).`);
    expect(failure.stdout).not.toContain('private diagnostic body');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

it('reads documents through the built CLI without credentials or a vault', async () => {
  const home = await mkdtemp(join(tmpdir(), 'inflow-document-test-'));
  let origin = '';
  const requests: string[] = [];
  const privateHeaders: string[] = [];
  let portable: unknown = vector.input.document;
  let advertisePortable = true;
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    for (const header of ['authorization', 'cookie', 'x-api-key', 'signature', 'signature-input']) {
      if (request.headers[header] !== undefined) privateHeaders.push(header);
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/.well-known/aep') {
      response.setHeader('Content-Type', 'application/aep+json');
      response.end(
        JSON.stringify({
          aep_version: '1.0',
          service: { did: `did:web:127.0.0.1%3A${new URL(origin).port}` },
          commands: { supported: ['inspect', 'enroll', 'grant', 'revoke', 'status'], grant_types: ['api-key'] },
          core: { signing_algorithms: ['ES256', 'EdDSA'] },
          bindings: { supported: ['http'] },
          identity: { methods: ['did:web'] },
          http: { endpoint_base: '/aep' },
          extensions: { supported: ['urn:aep:ext:aep-foundation:service-documents#v=1.0.0'] },
          service_documents: [
            {
              ...vector.input.descriptor,
              representations: [
                { media_type: 'text/html', url: `${origin}/terms` },
                ...(advertisePortable ? [{ media_type: 'application/json', url: `${origin}/terms.json` }] : []),
              ],
            },
          ],
        }),
      );
    } else if (request.url === '/terms.json') response.end(JSON.stringify(portable));
    else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  const run = (...args: string[]) =>
    execute(
      process.execPath,
      [binary, 'aep', 'document', origin, ...args, '--format', 'json', '--api-base-url', origin],
      {
        env: { HOME: home, PATH: process.env['PATH'], NO_UPDATE_NOTIFIER: '1' },
        timeout: 10_000,
      },
    );
  const mcp = async (method: string, params: Record<string, unknown>) => {
    const pending = execute(process.execPath, [binary, '--mcp', '--api-base-url', origin], {
      env: { HOME: home, PATH: process.env['PATH'], NO_UPDATE_NOTIFIER: '1' },
      timeout: 10_000,
    });
    pending.child.stdin?.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
    const { stdout, stderr } = await pending;
    expect(stderr).toBe('');
    // The process response boundary is checked by the assertions below.
    return JSON.parse(stdout.trim()) as McpResponse;
  };
  try {
    const schema = await execute(process.execPath, [binary, 'aep', 'document', '--schema', '--format', 'json'], {
      env: { HOME: home, PATH: process.env['PATH'], NO_UPDATE_NOTIFIER: '1' },
      timeout: 10_000,
    });
    const { output } = JSON.parse(schema.stdout) as { output: z.core.JSONSchema.BaseSchema };
    expect(output.type).toBe('object');
    expect(output.oneOf).toHaveLength(2);
    for (const variant of output.oneOf ?? []) {
      for (const field of Object.values(variant.properties ?? {})) {
        expect(field).toHaveProperty('description', expect.any(String));
      }
    }
    const responseSchema = z.fromJSONSchema(output);
    const full = await run('terms');
    expect(full.stderr).toBe('');
    const fullFrame: unknown = JSON.parse(full.stdout);
    expect(fullFrame).toMatchObject({ outcome: 'portable', document_id: 'terms', view: 'full' });
    expect(responseSchema.parse(fullFrame)).toEqual(fullFrame);
    expect(full.stdout).toContain('Use the service lawfully.');
    expect(full.stdout).not.toContain('"blocks"');
    const summary = await run('terms', '--summary');
    expect(responseSchema.parse(JSON.parse(summary.stdout))).toMatchObject({ view: 'summary' });
    expect(summary.stdout).toContain('Summary authored by the service.');
    expect(summary.stdout).not.toContain('Use the service lawfully.');
    const listing = await mcp('tools/list', {});
    const toolSchema = listing.result.tools?.find((item) => item.name === 'aep_document')?.outputSchema;
    expect(toolSchema?.type).toBe('object');
    if (toolSchema === undefined) throw new Error('Missing document tool output schema');
    expect(z.fromJSONSchema(toolSchema).parse(fullFrame)).toEqual(fullFrame);
    const portableTool = await mcp('tools/call', {
      name: 'aep_document',
      arguments: { serviceReference: origin, documentId: 'terms' },
    });
    expect(portableTool.error).toBeUndefined();
    expect(portableTool.result.isError).not.toBe(true);
    expect(portableTool.result.structuredContent).toEqual(fullFrame);
    expect(JSON.parse(portableTool.result.content?.[0]?.text ?? 'null')).toEqual(fullFrame);
    portable = { ...vector.input.document, id: 'wrong' };
    const fallback = await run('terms');
    const fallbackFrame: unknown = JSON.parse(fallback.stdout);
    expect(fallbackFrame).toMatchObject({ outcome: 'web', reason: 'unavailable_or_unsupported' });
    expect(responseSchema.parse(fallbackFrame)).toEqual(fallbackFrame);
    advertisePortable = false;
    const webTool = await mcp('tools/call', {
      name: 'aep_document',
      arguments: { serviceReference: origin, documentId: 'terms' },
    });
    expect(webTool.error).toBeUndefined();
    expect(webTool.result.isError).not.toBe(true);
    expect(responseSchema.parse(webTool.result.structuredContent)).toMatchObject({
      outcome: 'web',
      reason: 'not_advertised',
    });
    expect(webTool.result.structuredContent).toHaveProperty(
      'instruction',
      expect.stringContaining('does not acknowledge or accept'),
    );
    expect(JSON.parse(webTool.result.content?.[0]?.text ?? 'null')).toEqual(webTool.result.structuredContent);
    await expect(run('missing')).rejects.toMatchObject({ code: 2 });
    const missingTool = await mcp('tools/call', {
      name: 'aep_document',
      arguments: { serviceReference: origin, documentId: 'missing' },
    });
    expect(missingTool.result.isError).toBe(true);
    expect(missingTool.result.structuredContent).toBeUndefined();
    expect(privateHeaders).toEqual([]);
    expect(requests).toEqual([
      '/.well-known/aep',
      '/terms.json',
      '/.well-known/aep',
      '/terms.json',
      '/.well-known/aep',
      '/terms.json',
      '/.well-known/aep',
      '/terms.json',
      '/.well-known/aep',
      '/.well-known/aep',
      '/.well-known/aep',
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
