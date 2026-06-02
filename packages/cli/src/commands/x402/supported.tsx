import type { X402BuyerSupportedResponse } from '@inflowpayai/x402';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useCallback } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { useFlowState } from '../../hooks/use-flow-state.js';
import { Table, type TableColumn } from '../../utils/table.js';

type SupportedKind = X402BuyerSupportedResponse['kinds'][number];

const COLUMNS: ReadonlyArray<TableColumn<SupportedKind>> = [
  { header: 'Scheme', cell: (k) => k.scheme },
  { header: 'Network', cell: (k) => k.network },
];

export interface SupportedViewProps {
  load: () => Promise<X402BuyerSupportedResponse>;
  onComplete: (response: X402BuyerSupportedResponse | null) => void;
}

export const SupportedView: React.FC<SupportedViewProps> = ({ load, onComplete }) => {
  const action = useCallback(() => load(), [load]);
  const { finish } = useFlowExit(onComplete);
  const { status, data, error } = useFlowState(action, finish);

  if (status === 'loading') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Loading supported schemes...
        </Text>
      </Box>
    );
  }

  if (status === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">Failed to load supported schemes</Text>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  const kinds = data?.kinds ?? [];
  if (kinds.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No supported (scheme, network) pairs returned for this account.</Text>
      </Box>
    );
  }

  return <Table columns={COLUMNS} rows={kinds} />;
};
