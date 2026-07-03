/**
 * Programmatic login + balances.
 *
 * Drives the InFlow device-flow login from a Node script, then lists the authenticated user's balances. Demonstrates:
 *
 * - Constructing `Inflow` with `authStorage` only (no static credential up front; the device flow seeds the storage)
 * - Subscribing to `inflow.auth.login`'s async-iterable event stream and projecting each event into a console-friendly
 *   line
 * - Calling `inflow.balances.list` once the login terminal frame arrives (the data resources are auto-wired with a
 *   device-token provider backed by the same storage)
 *
 * Run from the workspace root: pnpm --filter @inflowpayai/inflow-core build # ensure dist/ is built node
 * --experimental-strip-types packages/core/examples/programmatic-login-and-balances.ts
 *
 * Or compile first: tsc packages/core/examples/programmatic-login-and-balances.ts node
 * packages/core/examples/programmatic-login-and-balances.js
 */
import { Inflow, MemoryStorage } from '@inflowpayai/inflow-core';

async function main(): Promise<void> {
  // Memory storage is enough for a one-shot script. For long-running tools, use the `Storage` class (config-file backed) and the tokens
  // persist across runs.
  const authStorage = new MemoryStorage();

  const inflow = new Inflow({
    authStorage,
    environment: 'sandbox',
    cliClientId: process.env['INFLOW_CLI_CLIENT_ID'] ?? '19ba1cd46402cf2695c3056da0ac03ab',
  });

  const run = inflow.auth.login({
    clientName: 'inflow-core example',
    connection: { environment: 'sandbox' },
  });

  for await (const event of run.events) {
    switch (event.type) {
      case 'initiated':
        process.stdout.write(
          `Open this URL to authenticate:\n  ${event.req.verification_url_complete}\nEnter phrase: ${event.req.user_code}\n`,
        );
        break;
      case 'tokensReceived':
        process.stdout.write('Authenticated.\n');
        break;
      case 'pollExpired':
        process.stderr.write('Device code expired before the user completed authentication.\n');
        process.exit(2);
        return;
      case 'pollDenied':
        process.stderr.write('Authorization denied by the user.\n');
        process.exit(2);
        return;
      case 'pollFailed':
        process.stderr.write(`Authentication failed: ${event.message}\n`);
        process.exit(1);
        return;
    }
  }

  // Balances request below uses the device-token provider auto-wired by the Inflow constructor — it reads from authStorage, refreshes if
  // expired, and threads `Authorization: Bearer` onto every request.
  const balances = await inflow.balances.list();
  if (balances.length === 0) {
    process.stdout.write('No balances on this account.\n');
    return;
  }
  process.stdout.write('Balances:\n');
  for (const b of balances) {
    process.stdout.write(`  ${b.currency.padEnd(8)} ${b.available}\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
