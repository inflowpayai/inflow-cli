export interface PaymentFetchNextCommandInput {
  protocol: 'mpp' | 'x402';
  transactionId: string;
  resourceUrl: string;
  method: string;
  interval: number;
  maxAttempts: number;
  showBody: boolean;
  outputFile?: string;
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
  ];
  if (input.method.toUpperCase() !== 'GET') parts.push('--method', shellArg(input.method));
  if (input.outputFile !== undefined) parts.push('--output-file', shellArg(input.outputFile));
  if (!input.showBody) parts.push('--no-show-body');
  return parts.join(' ');
}
