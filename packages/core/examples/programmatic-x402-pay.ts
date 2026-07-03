/**
 * Programmatic x402 pay.
 *
 * Drives the full x402 payment lifecycle from a Node script: probe an x402-protected URL, decode the seller's
 * PAYMENT-REQUIRED accepts, sign via the InFlow buyer client, await the approval, replay with the PAYMENT-SIGNATURE
 * header, and surface the seller's body bytes.
 *
 * Demonstrates:
 *
 * - Constructing `Inflow` with a static `apiKey` so the data + x402 resources are immediately usable (no device flow)
 * - Subscribing to `inflow.x402.pay`'s async-iterable event stream and projecting each event into a console-friendly line
 * - Reading the terminal frame to decide exit status (paid vs. replay-rejected vs. error)
 *
 * Environment:
 *
 * INFLOW_API_KEY — required, valid for the chosen environment INFLOW_ENVIRONMENT — 'sandbox' or 'production' (default
 * 'sandbox') INFLOW_BASE_URL — optional override of the SDK's default URL X402_SELLER_URL — required, the seller
 * endpoint to pay
 *
 * Run from the workspace root: INFLOW_API_KEY=... X402_SELLER_URL=https://seller.test/api\
 * Node --experimental-strip-types packages/core/examples/programmatic-x402-pay.ts
 */
import { Inflow, type PayEvent } from '@inflowpayai/inflow-core';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    process.stderr.write(`Missing required env var: ${name}\n`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const apiKey = requireEnv('INFLOW_API_KEY');
  const sellerUrl = requireEnv('X402_SELLER_URL');
  const environment = (process.env['INFLOW_ENVIRONMENT'] ?? 'sandbox') as 'sandbox' | 'production';
  const apiBaseUrl = process.env['INFLOW_BASE_URL'];

  const inflow = new Inflow({
    apiKey,
    environment,
    ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
  });

  const run = inflow.x402.pay({
    url: sellerUrl,
    probeOptions: { method: 'GET', headers: {} },
    signOptions: {},
    showBody: true,
  });

  let terminal: PayEvent | undefined;
  for await (const event of run.events) {
    switch (event.type) {
      case 'probed':
        process.stdout.write(`Probe: status ${String(event.probe.status)}\n`);
        break;
      case 'decoded':
        process.stdout.write(`Decoded PAYMENT-REQUIRED (${String(event.decoded.accepts.length)} accepts)\n`);
        break;
      case 'matched':
        process.stdout.write(`Matched ${event.requirement.scheme}/${event.requirement.network}\n`);
        break;
      case 'prepared':
        process.stdout.write(`Approval ${event.prepared.approvalId} — open: ${event.approvalUrl}\n`);
        break;
      case 'awaited':
        process.stdout.write('Approval signed.\n');
        break;
      case 'replayed':
        terminal = event;
        process.stdout.write(`Paid (status ${String(event.result.responseStatus)})\n`);
        if (event.result.body !== undefined) {
          process.stdout.write(`Body: ${event.result.body}\n`);
        }
        break;
      case 'rejected':
        terminal = event;
        process.stderr.write(`Replay rejected (status ${String(event.result.responseStatus)})\n`);
        break;
      case 'short-circuited':
        terminal = event;
        process.stdout.write(`Seller served without payment (status ${String(event.result.status)})\n`);
        break;
      case 'errored':
        terminal = event;
        process.stderr.write(`${event.code}: ${event.message}\n`);
        break;
    }
  }

  if (terminal === undefined) {
    process.stderr.write('Pipeline ended without a terminal frame.\n');
    process.exit(1);
  }
  if (terminal.type === 'replayed' || terminal.type === 'short-circuited') {
    process.exit(0);
  }
  process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
