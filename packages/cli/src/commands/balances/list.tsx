import type { Balance, IBalanceResource } from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useCallback } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { useFlowState } from '../../hooks/use-flow-state.js';
import { Table, type TableColumn } from '../../utils/table.js';

export interface BalancesListProps {
  balanceResource: Pick<IBalanceResource, 'list'>;
  onComplete: (result: Balance[] | null) => void;
}

const COLUMNS: ReadonlyArray<TableColumn<Balance>> = [
  { header: 'Currency', cell: (b) => b.currency },
  { header: 'Available', cell: (b) => b.available },
];

export const BalancesList: React.FC<BalancesListProps> = ({ balanceResource, onComplete }) => {
  const action = useCallback(() => balanceResource.list(), [balanceResource]);
  const { finish } = useFlowExit(onComplete);

  const { status, data: balances, error } = useFlowState(action, finish);

  if (status === 'loading') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Loading balances...
        </Text>
      </Box>
    );
  }

  if (status === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Failed to retrieve balances</Text>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (balances === null) return null;

  if (balances.length === 0) {
    return <Text dimColor>No balances.</Text>;
  }

  return <Table columns={COLUMNS} rows={balances} />;
};
