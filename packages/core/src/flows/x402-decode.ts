import type { PaymentRequirements } from '@inflowpayai/x402';
import { decodePaymentRequiredHeader } from '@inflowpayai/x402/http';
import type { PaymentRequired } from '@inflowpayai/x402/http';

export interface DecodedHeader {
  x402Version: number;
  resource: PaymentRequired['resource'];
  accepts: PaymentRequired['accepts'];
  extensions?: Record<string, unknown>;
  error?: string;
}

export function decodeHeader(raw: string): DecodedHeader {
  const parsed = decodePaymentRequiredHeader(raw);
  const decoded: DecodedHeader = {
    x402Version: parsed.x402Version,
    resource: parsed.resource,
    accepts: parsed.accepts,
  };
  if (parsed.extensions !== undefined) decoded.extensions = parsed.extensions;
  if (parsed.error !== undefined) decoded.error = parsed.error;
  return decoded;
}

export interface AcceptsSummary {
  scheme: string;
  network: string;
  asset?: string;
  amount?: string;
}

/**
 * Project a `PaymentRequirements[]` (InFlow-buyer-typed) into the compact `AcceptsSummary` rows the CLI renders inside
 * its tables. Empty-string `asset` / `amount` fields are dropped — the CLI surfaces only fields that carry a value.
 */
export function summarizeAccepts(accepts: readonly PaymentRequirements[]): AcceptsSummary[] {
  return accepts.map((entry) => {
    const summary: AcceptsSummary = {
      scheme: entry.scheme,
      network: entry.network,
    };
    if (entry.asset !== '') {
      summary.asset = entry.asset;
    }
    if (entry.amount !== '') {
      summary.amount = entry.amount;
    }
    return summary;
  });
}
