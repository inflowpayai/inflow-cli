import { type DecodedChallenge, type DecodeResult, decodeMppValue } from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import type React from 'react';

export { type DecodedChallenge, type DecodeResult, decodeMppValue };

export interface DecodeViewProps {
  result: DecodeResult;
}

function ChallengeBody({ challenge }: { challenge: DecodedChallenge }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold>Challenge</Text>
      <Text>
        {'method/intent: '}
        <Text color="yellow">
          {challenge.method} / {challenge.intent}
        </Text>
      </Text>
      <Text>{`id: ${challenge.id}`}</Text>
      <Text>{`realm: ${challenge.realm}`}</Text>
      {challenge.amount !== undefined ? (
        <Text>{`amount: ${challenge.amount}${challenge.currency !== undefined ? ` ${challenge.currency}` : ''}`}</Text>
      ) : null}
      {challenge.rail !== undefined ? <Text>{`rail: ${challenge.rail}`}</Text> : null}
      {challenge.expires !== undefined ? <Text dimColor>{`expires: ${challenge.expires}`}</Text> : null}
    </Box>
  );
}

export const DecodeView: React.FC<DecodeViewProps> = ({ result }) => {
  if (result.kind === 'challenge') {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold>Decoded WWW-Authenticate: Payment</Text>
        </Box>
        <ChallengeBody challenge={result.challenge} />
      </Box>
    );
  }
  if (result.kind === 'credential') {
    const { credential } = result;
    return (
      <Box flexDirection="column" paddingY={1}>
        <Box marginBottom={1}>
          <Text bold>Decoded Authorization: Payment credential</Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text>{`challenge id: ${credential.challenge.id}`}</Text>
          <Text>{`method: ${credential.challenge.method}`}</Text>
          <Text>{`source: ${credential.source}`}</Text>
          <Text dimColor>{`payload keys: ${Object.keys(credential.payload).join(', ') || '(none)'}`}</Text>
        </Box>
      </Box>
    );
  }
  const { receipt } = result;
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>Decoded Payment-Receipt</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text>
          {'status: '}
          <Text color="green">{receipt.status}</Text>
        </Text>
        <Text>{`reference: ${receipt.reference}`}</Text>
        <Text>{`settled: ${receipt.settlement.amount} ${receipt.settlement.currency}`}</Text>
        <Text dimColor>{`timestamp: ${receipt.timestamp}`}</Text>
      </Box>
    </Box>
  );
};
