import {
  createAepAgent,
  fetchProtectedResource,
  type AepAgentOptions,
  type AepClientAssertionSignerContext,
  type AgentCredentialRecord,
  type AgentCredentialStore,
  type AgentIdentityStore,
  type AgentServiceIdentity,
} from '@aep-foundation/agent';
import { HEADERS as MPP_HEADERS, parseChallengeHeaders, readHeaderAll as readMppHeaderAll } from '@inflowpayai/mpp';
import { HEADERS as X402_HEADERS, readHeader as readX402Header } from '@inflowpayai/x402';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { buildBodyAttachment, type BodyAttachment } from './x402-pay.js';

export type AepFetchAuthentication =
  | { outcome: 'not-required'; method: null }
  | {
      outcome: 'authenticated';
      method: 'aep-jwt' | 'credential';
      operation?: AepClientAssertionSignerContext['command'];
      credentialId?: string;
      grantType?: string;
    };

export interface AepFetchInput {
  agentOptions: AepAgentOptions;
  body?: string;
  credentialId?: string;
  grantType?: string;
  headers?: Record<string, string>;
  maxRedirects?: number;
  maxResponseBytes?: number;
  method?: string;
  outputFile?: string;
  showBody?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  url: string;
}

export interface AepFetchResult extends BodyAttachment {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  responseSizeBytes: number;
  redirected: boolean;
  serviceDid?: string;
  authentication: AepFetchAuthentication;
  paymentRequired?: AepFetchPaymentRequired;
}

export interface AepFetchPaymentRequired {
  protocols: Array<'mpp' | 'x402'>;
}

interface FetchTrace {
  credential?: AgentCredentialRecord;
  operation?: AepClientAssertionSignerContext['command'];
  serviceDid?: string;
}

export async function runAepFetch(input: AepFetchInput): Promise<AepFetchResult> {
  const trace: FetchTrace = {};
  const agent = createAepAgent(tracedAgentOptions(input.agentOptions, trace));
  const response = await fetchProtectedResource({
    agent,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
    ...(input.grantType === undefined ? {} : { grantType: input.grantType }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.maxRedirects === undefined ? {} : { maxRedirects: input.maxRedirects }),
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    url: input.url,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const maximum = input.maxResponseBytes ?? 16 * 1024 * 1024;
  if (bytes.byteLength > maximum)
    throw new AepFetchError('AEP_RESPONSE_TOO_LARGE', 'The response exceeded the size limit.');
  const attachment = await buildBodyAttachment(bytes, input.showBody ?? true, input.outputFile);
  const finalUrl = response.url.length === 0 ? input.url : response.url;
  const contentType = response.headers.get('content-type');
  const paymentRequired = detectPaymentRequired(response);
  return {
    ...attachment,
    authentication:
      trace.operation === undefined && trace.credential === undefined
        ? { method: null, outcome: 'not-required' }
        : trace.credential === undefined
          ? {
              method: 'aep-jwt',
              ...(trace.operation === undefined ? {} : { operation: trace.operation }),
              outcome: 'authenticated',
            }
          : {
              credentialId: trace.credential.credentialId,
              grantType: trace.credential.grantType,
              method: 'credential',
              ...(trace.operation === undefined ? {} : { operation: trace.operation }),
              outcome: 'authenticated',
            },
    ...(contentType === null ? {} : { contentType }),
    finalUrl,
    redirected: response.redirected || finalUrl !== input.url,
    requestedUrl: input.url,
    responseSizeBytes: bytes.byteLength,
    ...(trace.serviceDid === undefined ? {} : { serviceDid: trace.serviceDid }),
    ...(paymentRequired === undefined ? {} : { paymentRequired }),
    status: response.status,
  };
}

export class AepFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AepFetchError';
  }
}

function tracedAgentOptions(options: AepAgentOptions, trace: FetchTrace): AepAgentOptions {
  const identities =
    options.identityStore === undefined ? undefined : tracedIdentityStore(options.identityStore, trace);
  const credentials =
    options.credentialStore === undefined ? undefined : tracedCredentialStore(options.credentialStore, trace);
  return {
    ...options,
    ...(credentials === undefined ? {} : { credentialStore: credentials }),
    identityProvider: {
      getOrCreateIdentity: async (input) => {
        trace.serviceDid = input.serviceDid;
        return options.identityProvider.getOrCreateIdentity(input);
      },
      signerFor: async (identity) => {
        const signer = await options.identityProvider.signerFor(identity);
        return async (claims, context) => {
          trace.operation = context.command;
          return signer(claims, context);
        };
      },
    },
    ...(identities === undefined ? {} : { identityStore: identities }),
  };
}

function tracedIdentityStore(store: AgentIdentityStore, trace: FetchTrace): AgentIdentityStore {
  return {
    findByServiceDid: async (serviceDid) => {
      trace.serviceDid = serviceDid;
      return store.findByServiceDid(serviceDid);
    },
    saveIdentity: (identity: AgentServiceIdentity) => store.saveIdentity(identity),
  };
}

function tracedCredentialStore(store: AgentCredentialStore, trace: FetchTrace): AgentCredentialStore {
  const selected = (record: AgentCredentialRecord | undefined): AgentCredentialRecord | undefined => {
    if (record !== undefined) trace.credential = record;
    return record;
  };
  return {
    deleteCredential: (serviceDid, credentialId) => store.deleteCredential(serviceDid, credentialId),
    findCredential: async (serviceDid, credentialId) => selected(await store.findCredential(serviceDid, credentialId)),
    findUsableCredential: async (serviceDid, now) => selected(await store.findUsableCredential(serviceDid, now)),
    listCredentials: async (serviceDid) => {
      const records = await store.listCredentials(serviceDid);
      const [record] = records;
      if (records.length === 1 && record !== undefined) trace.credential = record;
      return records;
    },
    saveCredential: async (record) => {
      const saved = await store.saveCredential(record);
      trace.credential = saved;
      return saved;
    },
  };
}

function detectPaymentRequired(response: Response): AepFetchPaymentRequired | undefined {
  if (response.status !== 402) return undefined;
  const protocols: Array<'mpp' | 'x402'> = [];
  const mppHeaders = readMppHeaderAll(response.headers, MPP_HEADERS.WWW_AUTHENTICATE);
  if (mppHeaders.length > 0 && advertisesMppPayment(mppHeaders)) protocols.push('mpp');
  const x402Header = readX402Header(Object.fromEntries(response.headers.entries()), X402_HEADERS.PAYMENT_REQUIRED);
  if (x402Header !== undefined && advertisesX402Payment(x402Header)) protocols.push('x402');
  return protocols.length === 0 ? undefined : { protocols };
}

function advertisesMppPayment(headers: string[]): boolean {
  try {
    return parseChallengeHeaders(headers).length > 0;
  } catch {
    return false;
  }
}

function advertisesX402Payment(header: string): boolean {
  try {
    decodePaymentRequiredHeader(header);
    return true;
  } catch {
    return false;
  }
}
