import { Cli, Mcp, Schema } from 'incur';
import { describe, expect, it } from 'vitest';
import { httpUrlArgument } from '../../src/utils/http-url-argument.js';
import { inspectArgs } from '../../src/commands/inspect/schema.js';
import * as mpp from '../../src/commands/mpp/schema.js';
import * as x402 from '../../src/commands/x402/schema.js';
import { fetchArgs as aepFetchArgs } from '../../src/commands/aep/schema.js';
import { subscriptionFetchArgs } from '../../src/commands/subscriptions/schema.js';
import * as odp from '../../src/commands/odp/schema.js';
import { documentArgs } from '../../src/commands/openapi/schema.js';

describe('HTTP URL arguments', () => {
  it.each([
    ['demo.inflowpay.ai', 'https://demo.inflowpay.ai'],
    [' demo.inflowpay.ai/actions/item?q=a%20b#part ', 'https://demo.inflowpay.ai/actions/item?q=a%20b#part'],
    ['demo.inflowpay.ai:8443/actions', 'https://demo.inflowpay.ai:8443/actions'],
    ['localhost:3000/actions', 'https://localhost:3000/actions'],
    ['[::1]:3000/actions', 'https://[::1]:3000/actions'],
    ['http://127.0.0.1:3000/actions', 'http://127.0.0.1:3000/actions'],
    ['https://demo.inflowpay.ai/actions?x=1', 'https://demo.inflowpay.ai/actions?x=1'],
  ])('normalizes %s without dropping resource details', (input, expected) => {
    expect(httpUrlArgument.parse(input)).toBe(expected);
  });

  it.each(['', ' ', 'not a hostname', 'https://', 'ftp://example.com', 'mailto:user@example.com'])(
    'reports invalid input %s before transport',
    (input) => {
      expect(httpUrlArgument.safeParse(input).success).toBe(false);
    },
  );

  it.each([
    inspectArgs.shape.url,
    mpp.payArgs.shape.url,
    mpp.subscribeArgs.shape.url,
    mpp.fetchArgs.shape.resourceUrl,
    mpp.inspectArgs.shape.url,
    x402.payArgs.shape.url,
    x402.fetchArgs.shape.resourceUrl,
    x402.inspectArgs.shape.url,
    aepFetchArgs.shape.resourceUrl,
    subscriptionFetchArgs.shape.resourceUrl,
    odp.inspectArgs.shape.service,
    odp.collectionSearchArgs.shape.service,
    odp.collectionGetArgs.shape.service,
    odp.offeringSearchArgs.shape.service,
    odp.offeringGetArgs.shape.service,
    odp.actionResolveArgs.shape.service,
    documentArgs.shape.source,
  ])('normalizes the registered command argument', (schema) => {
    expect(schema.parse('demo.inflowpay.ai/path?q=1')).toBe('https://demo.inflowpay.ai/path?q=1');
    expect(Schema.toJsonSchema(schema, { io: 'input' })).toMatchObject({ type: 'string' });
  });

  it('normalizes through the actual command framework', async () => {
    let received: string | undefined;
    const cli = Cli.create('test', { description: 'Test', version: '0.0.0' }).command('inspect', {
      args: inspectArgs,
      run(c) {
        received = c.args.url;
        return { url: c.args.url };
      },
    });
    await cli.serve(['inspect', 'demo.inflowpay.ai/path?q=1', '--format', 'json'], { stdout: () => {} });
    expect(received).toBe('https://demo.inflowpay.ai/path?q=1');
  });

  it('normalizes an MCP call before invoking the command', async () => {
    const [tool] = Mcp.collectTools(
      new Map([
        [
          'inspect',
          {
            args: inspectArgs,
            run: (context: { args: { url: string } }) => ({ url: context.args.url }),
          },
        ],
      ]),
      [],
    );
    if (tool === undefined) throw new Error('Missing inspect tool');
    const result = await Mcp.callTool(tool, { url: 'demo.inflowpay.ai/path?q=1' });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: JSON.stringify({ url: 'https://demo.inflowpay.ai/path?q=1' }) }],
    });
  });
});
