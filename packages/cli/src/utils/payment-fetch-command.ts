export interface PaymentFetchNextCommandInput {
  protocol: 'mpp' | 'x402';
  transactionId: string;
  resourceUrl: string;
  method: string;
  interval: number;
  maxAttempts: number;
  timeout: number;
  showBody: boolean;
  outputFile?: string | undefined;
}

export function shellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildPaymentFetchNextCommand(input: PaymentFetchNextCommandInput): string {
  const parts = [
    input.protocol,
    'fetch',
    shellArg(input.transactionId),
    shellArg(input.resourceUrl),
    '--interval',
    String(input.interval),
    '--max-attempts',
    String(input.maxAttempts),
    '--timeout',
    String(input.timeout),
  ];
  if (input.method.toUpperCase() !== 'GET') parts.push('--method', shellArg(input.method));
  if (input.outputFile !== undefined) parts.push('--output-file', shellArg(input.outputFile));
  if (!input.showBody) parts.push('--no-show-body');
  return parts.join(' ');
}

export function buildPaymentFetchContinuation(
  input: PaymentFetchNextCommandInput & { data?: string | undefined; header: readonly string[] },
) {
  const requiresOriginalRequestOptions = input.data !== undefined || input.header.length > 0;
  return {
    ...(requiresOriginalRequestOptions ? {} : { command: buildPaymentFetchNextCommand(input) }),
    tool: `${input.protocol}_fetch`,
    input: {
      transactionId: input.transactionId,
      resourceUrl: input.resourceUrl,
      method: input.method,
      interval: input.interval,
      maxAttempts: input.maxAttempts,
      timeout: input.timeout,
      showBody: input.showBody,
      ...(input.outputFile === undefined ? {} : { outputFile: input.outputFile }),
    },
    requires_original_request_options: requiresOriginalRequestOptions,
    message:
      'Restore the original data and header arguments before calling Fetch if required. Resume this transaction; do not start another payment.',
    poll_interval_seconds: input.interval,
    until: 'resource fetch completes',
  };
}
