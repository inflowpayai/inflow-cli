import { sellerProbe, type SellerProbeOptions, type SellerProbeResult } from '@inflowpayai/x402-buyer/probe';
import { buildBodyAttachment, type BodyAttachment } from './x402-pay.js';
import { isSuccessStatus } from './x402-shared.js';

export const PAYMENT_REPLAY_OUTCOME_UNKNOWN_CODE = 'PAYMENT_REPLAY_OUTCOME_UNKNOWN';
export const PAYMENT_REPLAY_OUTCOME_UNKNOWN_MESSAGE =
  'The seller request failed after the payment credential was attached. The seller might have received or consumed the credential; do not automatically replay this request.';

export interface PaymentReplayInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: string;
  paymentHeaderName: string;
  paymentHeaderValue: string;
  showBody: boolean;
  outputFile?: string;
}

export interface PaymentReplayResult extends BodyAttachment {
  status: number;
  contentType: string | undefined;
  success: boolean;
  headers: Headers;
}

function withoutHeader(headers: Record<string, string>, headerName: string): Record<string, string> {
  const blocked = headerName.toLowerCase();
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== blocked));
}

export async function replayPaymentRequest(input: PaymentReplayInput): Promise<PaymentReplayResult> {
  let result: SellerProbeResult;
  try {
    const options: SellerProbeOptions = {
      method: input.method,
      headers: {
        ...withoutHeader(input.headers, input.paymentHeaderName),
        [input.paymentHeaderName]: input.paymentHeaderValue,
      },
      ...(input.data !== undefined ? { data: input.data } : {}),
    };
    result = await sellerProbe(input.url, options);
  } catch (err) {
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
