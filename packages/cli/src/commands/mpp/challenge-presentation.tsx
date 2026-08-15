import type { DecodedChallenge } from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import type React from 'react';
import { Table, type TableColumn } from '../../utils/table.js';

function orDash(value: string | undefined): string {
  return value === undefined || value === '' ? '—' : value;
}

const CHALLENGE_COLUMNS: ReadonlyArray<TableColumn<DecodedChallenge>> = [
  { header: 'Method', cell: (challenge) => challenge.method },
  { header: 'Intent', cell: (challenge) => challenge.intent },
  { header: 'Amount', cell: (challenge) => orDash(challenge.amount) },
  { header: 'Currency', cell: (challenge) => orDash(challenge.currency) },
  { header: 'Rail', cell: (challenge) => orDash(challenge.rail) },
];

interface DetailRow {
  field: string;
  value: string;
}

const DETAIL_COLUMNS: ReadonlyArray<TableColumn<DetailRow>> = [
  { header: 'Field', cell: (row) => row.field },
  { header: 'Value', cell: (row) => row.value },
];

function billingFrequency(challenge: DecodedChallenge): string {
  const count = challenge.periodCount ?? 1;
  const unit = challenge.periodUnit ?? 'unknown period';
  return count === 1 ? `Every ${unit}` : `Every ${String(count)} ${unit}s`;
}

function wholeSecondTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return timestamp.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function subscriptionRows(challenge: DecodedChallenge): DetailRow[] {
  const rows: DetailRow[] = [
    ...(challenge.optionId === undefined ? [] : [{ field: 'Option ID', value: challenge.optionId }]),
    {
      field: 'Price',
      value: [challenge.amount, challenge.currency].filter(Boolean).join(' ') || '—',
    },
    { field: 'Billing frequency', value: billingFrequency(challenge) },
  ];
  rows.push({
    field: 'Payment method',
    value: challenge.rail === undefined ? challenge.method : `${challenge.method} (${challenge.rail})`,
  });
  if (challenge.externalId !== undefined) rows.push({ field: 'Seller reference', value: challenge.externalId });
  if (challenge.subscriptionExpires !== undefined) {
    rows.push({ field: 'Subscription ends', value: wholeSecondTimestamp(challenge.subscriptionExpires) });
  }
  if (challenge.expires !== undefined)
    rows.push({ field: 'Accept by', value: wholeSecondTimestamp(challenge.expires) });
  return rows;
}

export const MppChallengePresentation: React.FC<{ challenges: readonly DecodedChallenge[] }> = ({ challenges }) => {
  const subscriptions = challenges.filter((challenge) => challenge.intent === 'subscription');
  return (
    <Box flexDirection="column">
      <Table columns={CHALLENGE_COLUMNS} rows={[...challenges]} />
      {subscriptions.map((challenge, index) => (
        <Box key={challenge.id} flexDirection="column" marginTop={1}>
          <Text bold>{`Subscription option ${String(index + 1)}`}</Text>
          <Table columns={DETAIL_COLUMNS} rows={subscriptionRows(challenge)} />
        </Box>
      ))}
    </Box>
  );
};

export const __testing = { billingFrequency, subscriptionRows, wholeSecondTimestamp };
