import { isRecord } from './documents.js';

export interface OpenApiPayment {
  advertised: boolean;
  protocols: Array<'mpp' | 'x402'>;
  offers: Record<string, unknown>[];
  response402: boolean;
  notes: string[];
}

export function operationPayment(operation: Record<string, unknown>): OpenApiPayment {
  const info = operation['x-payment-info'];
  const result: OpenApiPayment = {
    advertised: operation['x-payment-required'] === true || info !== undefined,
    protocols: [],
    offers: [],
    response402: isRecord(operation['responses']) && Object.hasOwn(operation['responses'], '402'),
    notes: [],
  };
  if (isRecord(info)) {
    if (Array.isArray(info['protocols'])) {
      for (const entry of info['protocols']) {
        for (const protocol of ['mpp', 'x402'] as const)
          if (
            (entry === protocol || (isRecord(entry) && isRecord(entry[protocol]))) &&
            !result.protocols.includes(protocol)
          )
            result.protocols.push(protocol);
      }
    }
    const offers = Array.isArray(info['offers']) ? info['offers'] : [info];
    for (const offer of offers) {
      if (
        isRecord(offer) &&
        typeof offer['method'] === 'string' &&
        offer['method'].length > 0 &&
        ['charge', 'session'].includes(String(offer['intent'])) &&
        (offer['amount'] === null || (typeof offer['amount'] === 'string' && /^(0|[1-9]\d*)$/.test(offer['amount'])))
      ) {
        result.offers.push(structuredClone(offer));
        if (!result.protocols.includes('mpp')) result.protocols.push('mpp');
      }
    }
  }
  if (result.advertised) {
    if (result.protocols.length === 0) result.notes.push('Payment is advertised, but its protocol is not recognized.');
    if (!result.response402) result.notes.push('The operation does not document a 402 response.');
    result.notes.push('Discovery is advisory. The runtime challenge determines payment terms and supported offers.');
  } else if (result.response402)
    result.notes.push('A 402 response is documented, but no payment protocol is advertised.');
  return result;
}
