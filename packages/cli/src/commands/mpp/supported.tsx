import type { MppSupportedResponse } from '@inflowpayai/mpp';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useCallback } from 'react';
import { useFlowExit } from '../../hooks/use-flow-exit.js';
import { useFlowState } from '../../hooks/use-flow-state.js';
import { Table, type TableColumn } from '../../utils/table.js';

interface SupportedRow {
  method: string;
  intent: string;
  rail: string;
  currencies: string;
}

/** Flatten the nested `kinds` (method → intents → rails) into one table row per method × intent × rail. */
function flattenKinds(response: MppSupportedResponse): SupportedRow[] {
  const rows: SupportedRow[] = [];
  for (const kind of response.kinds) {
    for (const intent of kind.intents) {
      for (const rail of intent.rails) {
        rows.push({
          method: kind.method,
          intent: intent.intent,
          rail: rail.rail,
          currencies: rail.currencies.join(', ') || '—',
        });
      }
    }
  }
  return rows;
}

const COLUMNS: ReadonlyArray<TableColumn<SupportedRow>> = [
  { header: 'Method', cell: (r) => r.method },
  { header: 'Intent', cell: (r) => r.intent },
  { header: 'Rail', cell: (r) => r.rail },
  { header: 'Currencies', cell: (r) => r.currencies },
];

export interface SupportedViewProps {
  load: () => Promise<MppSupportedResponse>;
  onComplete: (response: MppSupportedResponse | null) => void;
}

export const SupportedView: React.FC<SupportedViewProps> = ({ load, onComplete }) => {
  const action = useCallback(() => load(), [load]);
  const { finish } = useFlowExit(onComplete);
  const { status, data, error } = useFlowState(action, finish);

  if (status === 'loading') {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" /> Loading supported MPP methods...
        </Text>
      </Box>
    );
  }

  if (status === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">Failed to load supported MPP methods</Text>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  const rows = data ? flattenKinds(data) : [];
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No supported MPP methods returned for this account.</Text>
      </Box>
    );
  }

  return <Table columns={COLUMNS} rows={rows} />;
};
