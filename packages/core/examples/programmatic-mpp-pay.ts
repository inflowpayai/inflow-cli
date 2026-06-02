/**
 * Programmatic MPP pay.
 *
 * Drives the full MPP payment lifecycle from a Node script: probe an MPP-protected URL, parse the seller's
 * `WWW-Authenticate: Payment` challenge(s), create the buyer transaction, poll it to `ready`, replay with the
 * `Authorization: Payment` credential, and surface the seller's body bytes.
 *
 * Demonstrates:
 *
 * - Constructing `Inflow` with a static `apiKey` so the data + MPP resources are immediately usable (no device flow)
 * - Subscribing to `inflow.mpp.pay`'s async-iterable event stream and projecting each event into a console-friendly line
 * - Reading the terminal frame to decide exit status (paid vs. seller-rejected vs. error)
 *
 * Environment:
 *
 * INFLOW_API_KEY — required, valid for the chosen environment INFLOW_ENVIRONMENT — 'sandbox' or 'production' (default
 * 'sandbox') INFLOW_BASE_URL — optional override of the SDK's default URL MPP_SELLER_URL — required, the seller
 * endpoint to pay
 *
 * Run from the workspace root: INFLOW_API_KEY=... MPP_SELLER_URL=https://seller.test/api\
 * Node --experimental-strip-types packages/core/examples/programmatic-mpp-pay.ts
 */
import { Inflow, type MppPayEvent } from '@inflowpayai/inflow-core';

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
  const sellerUrl = requireEnv('MPP_SELLER_URL');
  const environment = (process.env.INFLOW_ENVIRONMENT ?? 'sandbox') as 'sandbox' | 'production';
  const apiBaseUrl = process.env.INFLOW_BASE_URL;

  const inflow = new Inflow({
    apiKey,
    environment,
    ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
  });

  // `interval > 0` drives the full lifecycle inline (create -> poll -> replay). Drop it for the two-process pattern.
  const run = inflow.mpp.pay({
    url: sellerUrl,
    probeOptions: { method: 'GET', headers: {} },
    showBody: true,
    interval: 5,
    maxAttempts: 60,
    timeout: 900,
  });

  let terminal: MppPayEvent | undefined;
  for await (const event of run.events) {
    switch (event.type) {
      case 'decoded':
        process.stdout.write(
          `Challenge: ${event.challenge.amount ?? '?'} ${event.challenge.currency ?? ''} (intent ${event.challenge.intent})\n`,
        );
        break;
      case 'created':
        process.stdout.write(
          `Transaction ${event.created.transactionId} — state ${event.created.state}${event.created.approvalUrl !== undefined ? ` — open: ${event.created.approvalUrl}` : ''}\n`,
        );
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
        process.stderr.write(`Seller rejected the credential (status ${String(event.result.responseStatus)})\n`);
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
