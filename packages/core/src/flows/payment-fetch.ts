import { sellerProbe, type SellerProbeOptions, type SellerProbeResult } from '@inflowpayai/x402-buyer/probe';
import { buildBodyAttachment, type BodyAttachment } from './x402-pay.js';
import { isSuccessStatus } from './x402-shared.js';

export const PAYMENT_REPLAY_OUTCOME_UNKNOWN_CODE = 'PAYMENT_REPLAY_OUTCOME_UNKNOWN';
export const PAYMENT_REPLAY_OUTCOME_UNKNOWN_MESSAGE =
  'The seller request failed after the payment credential was attached. The seller might have received or consumed the credential; do not automatically replay this request.';

export class SellerAuthenticationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'SellerAuthenticationError';
  }
}

export interface PaymentInspectionBlocked {
  method: string;
  url: string;
  message: string;
  source: 'openapi' | 'challenge';
  serviceDid?: string;
  serviceUrl?: string;
}

export class PaymentInspectionBlockedError extends Error {
  constructor(readonly blocked: PaymentInspectionBlocked) {
    super(blocked.message);
    this.name = 'PaymentInspectionBlockedError';
  }
}

export interface PaymentReplayInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: string;
  paymentHeaderName: string;
  paymentHeaderValue: string;
  showBody: boolean;
  outputFile?: string;
  sellerTransport?: SellerRequestTransport;
  transactionId?: string;
}

export interface PaymentReplayResult extends BodyAttachment {
  status: number;
  contentType: string | undefined;
  success: boolean;
  headers: Headers;
}

export interface SellerRequestInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: string;
  additionalAuthenticationHeaders?: Record<string, string>;
  transactionId?: string;
}

export interface SellerRequestTransport {
  request(input: SellerRequestInput): Promise<SellerRequestResult>;
}

export type SellerRequestResult = SellerProbeResult & { tapEvidenceId?: string };

function withoutHeader(headers: Record<string, string>, headerName: string): Record<string, string> {
  const blocked = headerName.toLowerCase();
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== blocked));
}

export const defaultSellerRequestTransport: SellerRequestTransport = {
  request: (input) => {
    const options: SellerProbeOptions = {
      method: input.method,
      headers: {
        ...input.headers,
        ...(input.additionalAuthenticationHeaders ?? {}),
      },
      ...(input.data !== undefined ? { data: input.data } : {}),
    };
    return sellerProbe(input.url, options);
  },
};

export async function sellerRequest(
  transport: SellerRequestTransport | undefined,
  input: SellerRequestInput,
): Promise<SellerRequestResult> {
  return (transport ?? defaultSellerRequestTransport).request(input);
}

export async function replayPaymentRequest(input: PaymentReplayInput): Promise<PaymentReplayResult> {
  let result: SellerProbeResult;
  try {
    const options: SellerRequestInput = {
      additionalAuthenticationHeaders: {
        [input.paymentHeaderName]: input.paymentHeaderValue,
      },
      method: input.method,
      headers: withoutHeader(input.headers, input.paymentHeaderName),
      ...(input.data !== undefined ? { data: input.data } : {}),
      ...(input.transactionId !== undefined ? { transactionId: input.transactionId } : {}),
      url: input.url,
    };
    result = await sellerRequest(input.sellerTransport, options);
  } catch (err) {
    if (err instanceof SellerAuthenticationError) throw err;
    throw new Error(PAYMENT_REPLAY_OUTCOME_UNKNOWN_MESSAGE, { cause: err });
  }
  const attachment = await buildBodyAttachment(result.bytes, input.showBody, input.outputFile);
  return {
    status: result.status,
    contentType: result.contentType,
    success: isSuccessStatus(result.status),
    headers: result.headers,
    ...attachment,
  };
}
