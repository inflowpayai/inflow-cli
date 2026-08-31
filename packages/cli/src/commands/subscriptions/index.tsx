import {
  type AuthStorage,
  type Inflow,
  InflowApiError,
  type ISubscriptionResource,
  type PagedSubscriptions,
  sanitizeDeep,
  type Subscription,
} from '@inflowpayai/inflow-core';
import { Text } from 'ink';
import Spinner from 'ink-spinner';
import { Cli } from 'incur';
import type React from 'react';
import { useCallback } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { useFlowState } from '../../hooks/use-flow-state.js';
import { mcpTool } from '../../mcp-metadata.js';
import { assertSessionGuard } from '../../utils/assert-session.js';
import { authenticatedApiError } from '../../utils/api-error.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { Table, type TableColumn } from '../../utils/table.js';
import { runPayCommand } from '../mpp/index.js';
import { fetchOptions } from '../mpp/schema.js';
import { listOptions, subscriptionFetchArgs, subscriptionIdArgs } from './schema.js';

interface CommandContext {
  agent: boolean;
  formatExplicit: boolean;
  error: (error: CommandError) => never;
}

interface CommandError {
  code: string;
  message: string;
  cta?: { commands: { command: string; description: string }[] };
  details?: unknown;
}

interface Dependencies {
  authStorage: AuthStorage;
  inflow: Inflow;
  subscriptions: ISubscriptionResource;
}

const COLUMNS: ReadonlyArray<TableColumn<Subscription>> = [
  { header: 'Subscription ID', cell: (subscription) => subscription.subscriptionId },
  { header: 'Seller', cell: (subscription) => subscription.sellerName ?? '—' },
  { header: 'Website', cell: (subscription) => sellerHostname(subscription.sellerWebsite) },
  { header: 'Status', cell: (subscription) => subscription.status },
  { header: 'Price', cell: (subscription) => `${subscription.amount} ${subscription.currency}` },
  {
    header: 'Billing frequency',
    cell: (subscription) => billingFrequency(subscription),
  },
  { header: 'Seller reference', cell: (subscription) => subscription.externalId ?? '—' },
  { header: 'Subscription ends', cell: (subscription) => wholeSecondTimestamp(subscription.subscriptionExpires) },
];

interface DetailRow {
  field: string;
  value: string;
}

const DETAIL_COLUMNS: ReadonlyArray<TableColumn<DetailRow>> = [
  { header: 'Field', cell: (row) => row.field },
  { header: 'Value', cell: (row) => row.value },
];

function commandError(error: unknown, fallbackCode: string): CommandError {
  const authenticated = authenticatedApiError(error);
  if (authenticated !== undefined) return authenticated;
  if (error instanceof InflowApiError) {
    return { code: error.code, details: { status: error.status }, message: error.message };
  }
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

function billingFrequency(subscription: Subscription): string {
  const unit = subscription.periodUnit.toLowerCase();
  return subscription.periodCount === 1 ? `Every ${unit}` : `Every ${String(subscription.periodCount)} ${unit}s`;
}

function wholeSecondTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return timestamp.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sellerHostname(website: string | undefined): string {
  if (website === undefined) return '—';
  try {
    return new URL(website).hostname;
  } catch {
    return website;
  }
}

function subscriptionDetailRows(subscription: Subscription): DetailRow[] {
  return [
    { field: 'Subscription ID', value: subscription.subscriptionId },
    ...(subscription.sellerName === undefined ? [] : [{ field: 'Seller name', value: subscription.sellerName }]),
    ...(subscription.sellerWebsite === undefined
      ? []
      : [{ field: 'Seller website', value: sellerHostname(subscription.sellerWebsite) }]),
    ...(subscription.externalId === undefined ? [] : [{ field: 'Seller reference', value: subscription.externalId }]),
    { field: 'Status', value: subscription.status },
    { field: 'Price', value: `${subscription.amount} ${subscription.currency}` },
    { field: 'Initial charge', value: `${subscription.period0Amount} ${subscription.currency}` },
    { field: 'Billing frequency', value: billingFrequency(subscription) },
    { field: 'Last charged period', value: String(subscription.lastChargedPeriod) },
    { field: 'Transaction type', value: subscription.transactionType },
    ...(subscription.buyerId === undefined ? [] : [{ field: 'Buyer ID', value: subscription.buyerId }]),
    ...(subscription.sellerId === undefined ? [] : [{ field: 'Seller ID', value: subscription.sellerId }]),
    { field: 'Billing anchor', value: wholeSecondTimestamp(subscription.billingAnchor) },
    ...(subscription.nextBillingDate === undefined
      ? []
      : [{ field: 'Next billing attempt', value: wholeSecondTimestamp(subscription.nextBillingDate) }]),
    { field: 'Subscription ends', value: wholeSecondTimestamp(subscription.subscriptionExpires) },
    ...(subscription.cancelled === undefined
      ? []
      : [{ field: 'Cancelled', value: wholeSecondTimestamp(subscription.cancelled) }]),
    ...(subscription.pastDue === undefined
      ? []
      : [{ field: 'Past due', value: wholeSecondTimestamp(subscription.pastDue) }]),
    ...(subscription.failed === undefined
      ? []
      : [{ field: 'Failed', value: wholeSecondTimestamp(subscription.failed) }]),
    { field: 'Created', value: wholeSecondTimestamp(subscription.created) },
    { field: 'Updated', value: wholeSecondTimestamp(subscription.updated) },
  ];
}

function useResource<T>(action: () => Promise<T>, onComplete: (result: T | null) => void) {
  const stableAction = useCallback(action, [action]);
  const { finish } = useFlowExit(onComplete);
  return useFlowState(stableAction, finish);
}

const SubscriptionListView: React.FC<{
  load: () => Promise<PagedSubscriptions>;
  onComplete: (result: PagedSubscriptions | null) => void;
}> = ({ load, onComplete }) => {
  const { status, data, error } = useResource(load, onComplete);
  if (status === 'loading')
    return (
      <Text color="cyan">
        <Spinner type="dots" /> Loading subscriptions...
      </Text>
    );
  if (status === 'error') return <Text color="red">Failed to list subscriptions: {error}</Text>;
  if (data === null) return null;
  if (data.data.length === 0) return <Text dimColor>No subscriptions.</Text>;
  return <Table columns={COLUMNS} rows={data.data} />;
};

const SubscriptionGetView: React.FC<{
  load: () => Promise<Subscription>;
  onComplete: (result: Subscription | null) => void;
}> = ({ load, onComplete }) => {
  const { status, data, error } = useResource(load, onComplete);
  if (status === 'loading')
    return (
      <Text color="cyan">
        <Spinner type="dots" /> Loading subscription...
      </Text>
    );
  if (status === 'error') return <Text color="red">Failed to get subscription: {error}</Text>;
  if (data === null) return null;
  return <Table columns={DETAIL_COLUMNS} rows={subscriptionDetailRows(data)} />;
};

const SubscriptionCancelView: React.FC<{
  cancel: () => Promise<void>;
  subscriptionId: string;
  onComplete: (result: boolean | null) => void;
}> = ({ cancel, subscriptionId, onComplete }) => {
  const { status, error } = useResource(async () => {
    await cancel();
    return true;
  }, onComplete);
  if (status === 'loading')
    return (
      <Text color="cyan">
        <Spinner type="dots" /> Cancelling subscription...
      </Text>
    );
  if (status === 'error') return <Text color="red">Failed to cancel subscription: {error}</Text>;
  return <Text color="green">Subscription {subscriptionId} cancelled.</Text>;
};

async function runList(
  c: CommandContext & {
    options: {
      offset: number;
      limit: number;
      descending: boolean;
      startDate?: string | undefined;
      endDate?: string | undefined;
      status?: string | undefined;
    };
  },
  deps: Dependencies,
): Promise<PagedSubscriptions> {
  assertSessionGuard(c, deps.authStorage, deps.inflow);
  const load = () =>
    deps.subscriptions.list({
      offset: c.options.offset,
      limit: c.options.limit,
      descending: c.options.descending,
      ...(c.options.startDate === undefined ? {} : { startDate: c.options.startDate }),
      ...(c.options.endDate === undefined ? {} : { endDate: c.options.endDate }),
      ...(c.options.status === undefined ? {} : { status: c.options.status }),
    });
  try {
    if (!c.agent && !c.formatExplicit) {
      let captured: PagedSubscriptions | null = null;
      const result = await renderInkUntilExit(
        <SubscriptionListView
          load={load}
          onComplete={(result) => {
            captured = result;
          }}
        />,
        () => captured,
      );
      if (result === null) {
        return c.error({ code: 'SUBSCRIPTION_LIST_FAILED', message: 'The subscriptions could not be listed.' });
      }
      return result;
    }
    return sanitizeDeep(await load());
  } catch (error) {
    return c.error(commandError(error, 'SUBSCRIPTION_LIST_FAILED'));
  }
}

async function* runFetch(
  c: CommandContext & {
    args: { resourceUrl: string; subscriptionId: string };
    options: {
      method: string;
      data?: string | undefined;
      header: string[];
      interval: number;
      maxAttempts: number;
      timeout: number;
      showBody: boolean;
      outputFile?: string | undefined;
    };
  },
  deps: Dependencies,
): AsyncGenerator<unknown, unknown> {
  assertSessionGuard(c, deps.authStorage, deps.inflow);
  const mapped = {
    ...c,
    args: { url: c.args.resourceUrl, subscriptionId: c.args.subscriptionId },
    options: { ...c.options, intent: 'subscription' },
  };
  const iterator = runPayCommand(mapped, deps.inflow, deps.authStorage, deps.inflow.resolvedApiBaseUrl);
  for (;;) {
    const next = await iterator.next();
    if (next.done) return next.value;
    const value = next.value;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      yield value;
      continue;
    }
    const source = value as Record<string, unknown>;
    if (source['state'] === 'ready') continue;
    const frame: Record<string, unknown> = {
      ...source,
      subscription_id: c.args.subscriptionId,
    };
    delete frame['transaction_id'];
    delete frame['credential'];
    yield frame;
  }
}

async function runGet(
  c: CommandContext & { args: { subscriptionId: string } },
  deps: Dependencies,
): Promise<Subscription> {
  assertSessionGuard(c, deps.authStorage, deps.inflow);
  const load = () => deps.subscriptions.get(c.args.subscriptionId);
  try {
    if (!c.agent && !c.formatExplicit) {
      let captured: Subscription | null = null;
      const result = await renderInkUntilExit(
        <SubscriptionGetView
          load={load}
          onComplete={(value) => {
            captured = value;
          }}
        />,
        () => captured,
      );
      if (result === null)
        return c.error({ code: 'SUBSCRIPTION_GET_FAILED', message: 'No subscription was returned.' });
      return result;
    }
    return sanitizeDeep(await load());
  } catch (error) {
    return c.error(commandError(error, 'SUBSCRIPTION_GET_FAILED'));
  }
}

async function runCancel(
  c: CommandContext & { args: { subscriptionId: string } },
  deps: Dependencies,
): Promise<{ cancelled: true; subscription_id: string }> {
  assertSessionGuard(c, deps.authStorage, deps.inflow);
  const cancel = () => deps.subscriptions.cancel(c.args.subscriptionId);
  try {
    if (!c.agent && !c.formatExplicit) {
      const captured = { cancelled: false };
      await renderInkUntilExit(
        <SubscriptionCancelView
          cancel={cancel}
          subscriptionId={c.args.subscriptionId}
          onComplete={(result) => {
            captured.cancelled = result === true;
          }}
        />,
      );
      if (!captured.cancelled) {
        return c.error({ code: 'SUBSCRIPTION_CANCEL_FAILED', message: 'The subscription was not cancelled.' });
      }
    } else {
      await cancel();
    }
  } catch (error) {
    return c.error(commandError(error, 'SUBSCRIPTION_CANCEL_FAILED'));
  }
  return { cancelled: true, subscription_id: c.args.subscriptionId };
}

export function createSubscriptionsCli(subscriptions: ISubscriptionResource, authStorage: AuthStorage, inflow: Inflow) {
  const deps = { subscriptions, authStorage, inflow };
  const cli = Cli.create('subscriptions', { description: 'Subscription management commands' });
  cli.command('list', {
    description: 'List your subscriptions.',
    mcp: mcpTool('subscriptions_list'),
    options: listOptions,
    outputPolicy: 'agent-only' as const,
    run: (c) => runList(c, deps),
  });
  cli.command('get', {
    description: 'View your subscription details.',
    mcp: mcpTool('subscriptions_get'),
    args: subscriptionIdArgs,
    outputPolicy: 'agent-only' as const,
    run: (c) => runGet(c, deps),
  });
  cli.command('fetch', {
    description: 'Fetch a resource using your active subscription.',
    mcp: mcpTool('subscriptions_fetch'),
    args: subscriptionFetchArgs,
    options: fetchOptions,
    outputPolicy: 'agent-only' as const,
    async *run(c) {
      return yield* runFetch(c, deps);
    },
  });
  cli.command('cancel', {
    description: 'Cancel your subscription immediately.',
    mcp: mcpTool('subscriptions_cancel'),
    args: subscriptionIdArgs,
    outputPolicy: 'agent-only' as const,
    run: (c) => runCancel(c, deps),
  });
  return cli;
}

export const __testing = {
  billingFrequency,
  runCancel,
  runFetch,
  runGet,
  runList,
  subscriptionDetailRows,
  SubscriptionCancelView,
  SubscriptionGetView,
  SubscriptionListView,
  wholeSecondTimestamp,
};
