import {
  PAYMENT_OPTIONS,
  type DirectoryServiceFilters,
  type PaymentOption,
  type PaymentProtocol,
} from '@inflowpayai/inflow-core';

type PaymentName = PaymentProtocol['name'];
type EnrollmentName = NonNullable<DirectoryServiceFilters['enrollment']>[number]['name'];
export type PaymentFilter = PaymentName | `${PaymentName}:${PaymentOption}`;

const OPTION_LABELS: Record<PaymentOption, string> = {
  algorand: 'Algorand',
  aptos: 'Aptos',
  arbitrum: 'Arbitrum',
  avalanche: 'Avalanche',
  base: 'Base',
  card: 'Card',
  ethereum: 'Ethereum',
  hedera: 'Hedera',
  inflow: 'InFlow',
  lightning: 'Lightning',
  polygon: 'Polygon',
  solana: 'Solana',
  stellar: 'Stellar',
  stripe: 'Stripe',
  tempo: 'Tempo',
  ton: 'TON',
};

const ENROLLMENT_LABELS: Record<EnrollmentName, string> = {
  aep: 'AEP',
};

export const PAYMENT_FILTERS: readonly PaymentFilter[] = Object.freeze([
  'mpp',
  'x402',
  ...PAYMENT_OPTIONS.map((option): PaymentFilter => `mpp:${option}`),
  ...PAYMENT_OPTIONS.map((option): PaymentFilter => `x402:${option}`),
]);

export function enrollmentProtocolLabel(name: EnrollmentName): string {
  return ENROLLMENT_LABELS[name];
}

export function normalizePaymentFilters(
  values: readonly PaymentFilter[],
): NonNullable<DirectoryServiceFilters['payments']> {
  const grouped = new Map<PaymentName, Set<PaymentOption> | null>();
  for (const value of values) {
    const separator = value.indexOf(':');
    const nameValue = separator === -1 ? value : value.slice(0, separator);
    if (nameValue !== 'mpp' && nameValue !== 'x402') throw new TypeError('Invalid payment filter.');
    if (separator === -1) {
      grouped.set(nameValue, null);
      continue;
    }
    if (grouped.get(nameValue) === null) continue;
    const optionValue = value.slice(separator + 1);
    const option = PAYMENT_OPTIONS.find((candidate) => candidate === optionValue);
    if (option === undefined) throw new TypeError('Invalid payment filter.');
    const options = grouped.get(nameValue) ?? new Set<PaymentOption>();
    options.add(option);
    grouped.set(nameValue, options);
  }
  return [...grouped].map(([name, options]) => ({
    name,
    ...(options === null ? {} : { options: [...options] }),
  }));
}

export function paymentNameLabel(name: PaymentName): string {
  return name === 'mpp' ? 'MPP' : 'x402';
}

export function paymentOptionLabel(option: PaymentOption): string {
  return OPTION_LABELS[option];
}

export function paymentProtocolLabel(payment: Pick<PaymentProtocol, 'name' | 'options'>): string {
  const name = paymentNameLabel(payment.name);
  return payment.options === undefined ? name : `${name}: ${payment.options.map(paymentOptionLabel).join(', ')}`;
}
