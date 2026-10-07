import type { CardVerification } from '@inflowpayai/inflow-core';
import { Box, Text, useInput, useStdin } from 'ink';
import { openUrl } from '../utils/open-url.js';
import {
  buildPaymentFetchContinuation,
  shellArg,
  type PaymentFetchNextCommandInput,
} from '../utils/payment-fetch-command.js';

function resumeCommand(protocol: 'mpp' | 'x402', verification: CardVerification): string {
  return `inflow ${protocol} fetch ${shellArg(verification.transactionId)} ${shellArg(verification.url)} --method ${shellArg(verification.method)} --interval 5`;
}

export function cardVerificationFrame(
  protocol: 'mpp' | 'x402',
  verification: CardVerification,
  options: Pick<PaymentFetchNextCommandInput, 'interval' | 'maxAttempts' | 'timeout' | 'showBody' | 'outputFile'> & {
    data?: string | undefined;
    header: readonly string[];
  },
): Record<string, unknown> {
  return {
    outcome: 'verification-required',
    protocol,
    transaction_id: verification.transactionId,
    verification_url: verification.verificationUrl,
    waiting: verification.waiting,
    reason: verification.reason,
    message: 'Complete bank verification in your browser. Resume this transaction; do not start another payment.',
    ...(verification.waiting
      ? {}
      : {
          _next: buildPaymentFetchContinuation({
            ...options,
            protocol,
            transactionId: verification.transactionId,
            resourceUrl: verification.url,
            method: verification.method,
            interval: options.interval > 0 ? options.interval : 5,
          }),
        }),
  };
}

export function CardVerificationView({
  protocol,
  verification,
  onStop,
}: {
  protocol: 'mpp' | 'x402';
  verification: CardVerification;
  onStop: () => void;
}) {
  const { isRawModeSupported } = useStdin();
  useInput(
    (_input, key) => {
      if (key.return) openUrl(verification.verificationUrl);
      if (key.escape) onStop();
    },
    { isActive: isRawModeSupported === true && verification.waiting },
  );
  return (
    <Box flexDirection="column">
      <Text bold>Bank verification required</Text>
      <Text>Your InFlow approval is complete. Your bank needs you to verify this card payment.</Text>
      <Text>{verification.verificationUrl}</Text>
      <Text>{`Transaction: ${verification.transactionId}`}</Text>
      {verification.waiting ? (
        <Text>Press Enter to open your browser. Press Escape to stop waiting without cancelling the payment.</Text>
      ) : (
        <Text>
          {verification.reason === 'timeout' ? 'The waiting limit was reached.' : 'The payment has not been cancelled.'}
        </Text>
      )}
      {!verification.waiting && (
        <>
          <Text>{`Resume: ${resumeCommand(protocol, verification)}`}</Text>
          <Text>
            Use the original request body and headers, and the same output options. Do not start another payment.
          </Text>
        </>
      )}
    </Box>
  );
}
