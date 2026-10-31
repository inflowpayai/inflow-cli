import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { PassThrough } from 'node:stream';
import type * as Ink from 'ink';
import { AepFetchError, AepStorage, MemoryStorage, SecureStorageError } from '@inflowpayai/inflow-core';
import {
  AepClaimRequirementsError,
  AepClaimValuesError,
  AepCommandError,
  AepInspectError,
  AepServiceReferenceError,
} from '@aep-foundation/agent';
import type { InspectServiceResult } from '@aep-foundation/agent';
import * as AepAgent from '@aep-foundation/agent';
import type * as InflowCore from '@inflowpayai/inflow-core';
import { enrollOptions, grantOptions, serviceReferenceArgs } from '../../../../src/commands/aep/schema.js';
import * as responseSchemas from '../../../../src/commands/aep/schema.js';
import { Schema } from 'incur';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { PendingApprovalView } from '../../../../src/commands/aep/views.js';

const rendering = vi.hoisted(() => ({
  render: vi.fn((_element: unknown) => ({ clear: vi.fn(), rerender: vi.fn(), unmount: vi.fn() })),
  present: vi.fn(async (element: ReactElement) => {
    const actual = await vi.importActual<typeof Ink>('ink');
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const instance = actual.render(element, {
      // These noninteractive views only need ordinary stream operations from Ink's terminal interfaces.
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await instance.waitUntilExit();
    } finally {
      instance.unmount();
      stdout.destroy();
      stderr.destroy();
      stdin.destroy();
    }
  }),
}));

vi.mock('ink', async (importOriginal) => ({
  ...(await importOriginal<typeof Ink>()),
  render: rendering.render,
}));
vi.mock('../../../../src/utils/render-ink-until-exit.js', () => ({ renderInkUntilExit: rendering.present }));

const platformRecovery = vi.hoisted<{
  identity: unknown;
  identityNotFoundOnSign: boolean;
  immediateSignResult: 'completed' | 'completed-without-context' | 'string' | undefined;
  notRecognized: boolean;
  provisioned: boolean;
  statusErrorCode: string | undefined;
  approvalsCreated: number;
  signContexts: Record<string, unknown>[];
  approvedDocumentIds: unknown;
}>(() => ({
  identity: undefined,
  identityNotFoundOnSign: false,
  immediateSignResult: undefined,
  notRecognized: false,
  provisioned: false,
  statusErrorCode: undefined,
  approvalsCreated: 0,
  signContexts: [],
  approvedDocumentIds: undefined,
}));

const fetchScenario = vi.hoisted(() => ({
  run: (_input: unknown): Promise<unknown> =>
    Promise.resolve({
      authentication: { method: null, outcome: 'not-required' },
      body: 'anonymous',
      bodySizeBytes: 9,
      contentType: 'text/plain',
      finalUrl: 'https://service.example/resource',
      redirected: false,
      requestedUrl: 'https://service.example/resource',
      responseSizeBytes: 9,
      status: 200,
    }),
}));

const probeScenario = vi.hoisted<{ calls: number; classification: string; status: number }>(() => ({
  calls: 0,
  classification: 'success',
  status: 204,
}));

const openApiScenario = vi.hoisted<{
  policy:
    | {
        freshness: 'fresh' | 'revalidated' | 'fetched';
        matchedOperation?: { method: string; pathTemplate: string };
        methods: string[];
        source: 'openapi';
        state: 'public' | 'required' | 'fallback';
        strictSlashSuggestion?: string;
      }
    | undefined;
}>(() => ({
  policy: undefined,
}));

vi.mock('@inflowpayai/inflow-core', async (importOriginal) => {
  const actual = await importOriginal<typeof InflowCore>();
  return { ...actual, runAepFetch: (input: unknown) => fetchScenario.run(input) };
});

const identity = {
  agentDid: 'did:web:platform.example:agents:one',
  identityKind: 'platform-hosted' as const,
  serviceDid: 'did:web:service.example',
  signingAlgorithms: ['ES256'],
};
const inspect: InspectServiceResult = {
  commandUrl: (command: string) => new URL(`https://service.example/aep/${command}`),
  document: {
    aep_version: '1.0',
    bindings: { supported: ['http'] },
    claims: { optional: [], preferred: [], required: [] },
    commands: { grant_types: ['oauth-bearer'], supported: ['inspect', 'enroll', 'grant', 'revoke', 'status'] },
    core: { signing_algorithms: ['ES256'] },
    http: { endpoint_base: '/aep' },
    identity: { methods: ['did:web'] },
    service: { did: identity.serviceDid },
  },
  finalUrl: new URL('https://service.example/.well-known/aep'),
  inspectUrl: new URL('https://service.example/.well-known/aep'),
};

vi.mock('@aep-foundation/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof AepAgent>();
  class AepClaimRequirementsError extends Error {
    constructor(readonly missingRequiredClaimNames: string[]) {
      super('Required AEP claims are unavailable.');
    }
  }
  class AepClaimValuesError extends Error {
    constructor(readonly issues: Array<{ path: string; message: string }>) {
      super('AEP Claim Values failed validation.');
    }
  }
  const AepCommandError = actual.AepCommandError;
  class AepInspectError extends Error {
    constructor(
      message: string,
      readonly code = 'http_error',
      readonly status?: number,
    ) {
      super(message);
    }
  }
  class AepPendingSignError extends Error {}
  class AepServiceReferenceError extends Error {}
  const signer = (_claims: unknown, context: { platformContext?: Record<string, unknown> }) => {
    platformRecovery.signContexts.push(structuredClone(context.platformContext ?? {}));
    if (platformRecovery.identityNotFoundOnSign) {
      platformRecovery.identityNotFoundOnSign = false;
      throw new AepCommandError('Identity not found', 404, {
        code: 'agent_identity_not_found',
        status: 404,
        title: 'Identity not found',
        type: 'urn:aep:error:agent_identity_not_found',
      });
    }
    if (platformRecovery.immediateSignResult === 'string') return 'immediate-assertion';
    if (platformRecovery.immediateSignResult === 'completed-without-context') {
      return { clientAssertion: 'immediate-assertion', status: 'completed' as const };
    }
    if (platformRecovery.immediateSignResult === 'completed') {
      return {
        clientAssertion: 'immediate-assertion',
        platformContext: {
          approved_claims: { 'contact.email': 'agent@example.test' },
          ...(platformRecovery.approvedDocumentIds === undefined
            ? {}
            : { approved_document_ids: platformRecovery.approvedDocumentIds }),
        },
        status: 'completed' as const,
      };
    }
    if (context.platformContext?.['claims'] !== undefined || context.platformContext?.['grant_type'] !== undefined) {
      platformRecovery.approvalsCreated += 1;
      return { platformContext: { approval_id: 'approval-1' }, retryAfterSeconds: 1, status: 'pending' as const };
    }
    return {
      clientAssertion: 'assertion',
      platformContext: {
        approved_claims: { 'contact.email': 'agent@example.test' },
        ...(platformRecovery.approvedDocumentIds === undefined
          ? {}
          : { approved_document_ids: platformRecovery.approvedDocumentIds }),
      },
      status: 'completed' as const,
    };
  };
  return {
    AepPendingSignResolverError: actual.AepPendingSignResolverError,
    readAepServiceDocument: actual.readAepServiceDocument,
    AepClaimRequirementsError,
    AepClaimValuesError,
    AepCommandError,
    AepInspectError,
    AepPendingSignError,
    AepServiceReferenceError,
    buildClientAssertionClaims: ({ command }: { command: string }) => ({ op: command }),
    createPlatformIdentityProvider: () => ({
      findIdentityByServiceDid: () => platformRecovery.identity,
      getOrCreateIdentity: () => {
        platformRecovery.provisioned = platformRecovery.identity === undefined;
        return platformRecovery.identity ?? identity;
      },
      signerFor: () => signer,
    }),
    enrollService: () => ({ body: { status: 'active' } }),
    grantService: () => ({
      body: { credential_id: 'credential-1', expires_at: '2999-01-01T00:00:00.000Z', scopes: ['read'] },
    }),
    inspectOpenApiPolicy: () =>
      openApiScenario.policy ?? {
        freshness: 'fetched',
        methods: [],
        source: 'openapi',
        state: 'fallback',
      },
    probeProtectedResource: () => {
      probeScenario.calls += 1;
      return {
        classification: probeScenario.classification,
        response: new Response(null, { status: probeScenario.status }),
      };
    },
    resolveServiceReference: (reference: string) => new URL(`https://${reference.split('/')[0]}`),
    revokeService: () => ({}),
    sessionCredentialRecordFromGrantResult: () => ({
      credential: { scopes: ['read'] },
      credentialId: 'credential-1',
      expiresAt: '2999-01-01T00:00:00.000Z',
      grantType: 'oauth-bearer',
      issuedAt: '2026-01-01T00:00:00.000Z',
      serviceDid: identity.serviceDid,
    }),
    statusService: () => {
      if (
        platformRecovery.notRecognized ||
        platformRecovery.provisioned ||
        platformRecovery.statusErrorCode !== undefined
      ) {
        platformRecovery.provisioned = false;
        throw new AepCommandError('Identity not recognized', 404, {
          code: platformRecovery.statusErrorCode ?? 'not_recognized',
          status: 404,
          title: 'Identity not recognized',
          type: `urn:aep:error:${platformRecovery.statusErrorCode ?? 'not_recognized'}`,
        });
      }
      return { body: { status: 'active' } };
    },
  };
});

const { __testing, createAepCli } = await import('../../../../src/commands/aep/index.js');

const outputSchemas = {
  runEnroll: responseSchemas.enrollOutput,
  runFetch: responseSchemas.fetchOutput,
  runGrant: responseSchemas.grantOutput,
  runInspect: responseSchemas.inspectOutput,
  runRevoke: responseSchemas.revokeOutput,
  runStatus: responseSchemas.statusOutput,
};
const checkOutputs: Array<() => Promise<void>> = [];
beforeEach(() => {
  checkOutputs.length = 0;
  for (const name of ['runEnroll', 'runFetch', 'runGrant', 'runInspect', 'runRevoke', 'runStatus'] as const) {
    const spy = vi.spyOn(__testing, name);
    checkOutputs.push(async () => {
      for (const result of spy.mock.settledResults) {
        if (result.type === 'fulfilled') {
          const parsed = outputSchemas[name].safeParse(JSON.parse(JSON.stringify(result.value)));
          expect(parsed.error, `${name} response schema`).toBeUndefined();
          const validator = fromJsonSchema(Schema.toJsonSchema(outputSchemas[name]));
          const validated = await validator['~standard'].validate(JSON.parse(JSON.stringify(result.value)));
          expect(validated.issues, `${name} MCP output validation`).toBeUndefined();
        }
      }
    });
  }
});

function context(options: Record<string, unknown> = {}) {
  return {
    agent: true,
    args: { serviceReference: 'service.example' },
    error: (error: { code: string }) => {
      throw new Error(error.code);
    },
    formatExplicit: true,
    options,
  };
}

function inflow(inspectResult: InspectServiceResult = inspect): InflowCore.Inflow {
  return {
    aep: { inspect: () => inspectResult },
    hasApiKey: () => false,
    platformAuthenticationHeaders: () => ({ 'X-API-KEY': 'key' }),
    resolvedApiBaseUrl: 'https://platform.example',
    tap: { canSign: () => false },
    user: { retrieve: () => ({ userId: 'user-1' }) },
  } as never;
}

afterEach(async () => {
  for (const check of checkOutputs) await check();
  vi.useRealTimers();
  rendering.render.mockClear();
  rendering.present.mockClear();
  platformRecovery.identity = undefined;
  platformRecovery.identityNotFoundOnSign = false;
  platformRecovery.immediateSignResult = undefined;
  platformRecovery.notRecognized = false;
  platformRecovery.provisioned = false;
  platformRecovery.statusErrorCode = undefined;
  platformRecovery.approvalsCreated = 0;
  platformRecovery.signContexts = [];
  platformRecovery.approvedDocumentIds = undefined;
  probeScenario.classification = 'success';
  probeScenario.calls = 0;
  probeScenario.status = 204;
  openApiScenario.policy = undefined;
  fetchScenario.run = (_input: unknown) =>
    Promise.resolve({
      authentication: { method: null, outcome: 'not-required' },
      body: 'anonymous',
      bodySizeBytes: 9,
      contentType: 'text/plain',
      finalUrl: 'https://service.example/resource',
      redirected: false,
      requestedUrl: 'https://service.example/resource',
      responseSizeBytes: 9,
      status: 200,
    });
  vi.restoreAllMocks();
});

describe('aep commands', () => {
  const serviceDocument: AepAgent.AepDocumentReadResult['descriptor'] = {
    id: 'terms',
    type: 'terms_of_service',
    title: 'Terms',
    enrollment: 'required',
    representations: [{ media_type: 'text/html', url: 'https://service.example/terms' }],
  };

  it.each([true, false])('reads a document without authentication in agent mode %s', async (agent) => {
    const client = new (await vi.importActual<typeof InflowCore>('@inflowpayai/inflow-core')).Inflow();
    const inspectCall = vi
      .spyOn(client.aep, 'inspect')
      .mockResolvedValue({ ...inspect, document: { ...inspect.document, service_documents: [serviceDocument] } });
    const user = vi.spyOn(client.user, 'retrieve').mockRejectedValue(new Error('No authentication allowed'));
    const c = {
      ...context({ summary: false, timeout: 10 }),
      agent,
      formatExplicit: agent,
      args: { serviceReference: 'service.example', documentId: 'terms' },
    };
    const frame = await __testing.runDocument(c, client);
    expect(frame).toMatchObject({ outcome: 'web', document_id: 'terms', web_url: 'https://service.example/terms' });
    expect(inspectCall.mock.calls[0]?.[0].serviceUrl).toBe('service.example');
    expect(inspectCall.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(user).not.toHaveBeenCalled();
    expect(rendering.present).toHaveBeenCalledTimes(agent ? 0 : 1);
  });

  it.each([undefined, [serviceDocument]])('reports missing document IDs in catalog %j', async (documents) => {
    const client = inflow({
      ...inspect,
      document: { ...inspect.document, ...(documents === undefined ? {} : { service_documents: documents }) },
    });
    await expect(
      __testing.runDocument(
        { ...context({ timeout: 10 }), args: { serviceReference: 'service.example', documentId: 'missing' } },
        client,
      ),
    ).rejects.toThrow('AEP_DOCUMENT_NOT_FOUND');
  });

  it('preserves Inspect failures when reading a document', async () => {
    const client = inflow();
    vi.spyOn(client.aep, 'inspect').mockRejectedValue(new AepServiceReferenceError('Invalid reference'));
    await expect(
      __testing.runDocument(
        { ...context({ timeout: 10 }), args: { serviceReference: 'bad', documentId: 'terms' } },
        client,
      ),
    ).rejects.toThrow('AEP_SERVICE_URL_INVALID');
  });

  it('includes Service documents in standalone Inspect JSON', async () => {
    const client = inflow({ ...inspect, document: { ...inspect.document, service_documents: [serviceDocument] } });
    const frame = await __testing.runInspect(context({ timeout: 30 }), client);
    expect(frame).toHaveProperty('document.service_documents', [serviceDocument]);
  });

  it('uses the requested Inspect URL when no redirect URL is supplied', async () => {
    const inspected = { ...inspect };
    delete inspected.finalUrl;
    const client = inflow(inspected);
    const frame = await __testing.runInspect(
      {
        ...context({ timeout: 30 }),
        args: { serviceReference: 'https://service.example' },
      },
      client,
    );
    expect(frame).toHaveProperty('resolved.service_url', 'https://service.example');
  });

  it.each([undefined, null])('renders an omitted grant scope list as empty: %s', async (scopes) => {
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' });
    await persisted.identities().saveIdentity(identity);
    platformRecovery.immediateSignResult = 'completed';
    vi.spyOn(AepAgent, 'sessionCredentialRecordFromGrantResult').mockReturnValue({
      credential: { ...(scopes === undefined ? {} : { scopes }) },
      credentialId: 'credential-1',
      expiresAt: '2999-01-01T00:00:00.000Z',
      grantType: 'oauth-bearer',
      issuedAt: '2026-01-01T00:00:00.000Z',
      serviceDid: identity.serviceDid,
    });
    const frame = await __testing.runGrant(
      { ...context({ scope: [] }), agent: false, formatExplicit: false },
      inflow(),
      storage,
    );
    expect(frame).toHaveProperty('scopes', []);
    expect(await persisted.credentials().findCredential(identity.serviceDid, 'credential-1')).toBeDefined();
  });

  it('reports no available grant types for an enrolled JWT-only Service', async () => {
    const document = structuredClone(inspect.document);
    delete document.commands.grant_types;
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' });
    await persisted.identities().saveIdentity(identity);
    await expect(__testing.runStatus(context(), inflow({ ...inspect, document }), storage)).resolves.toHaveProperty(
      'local.available_grant_types',
      [],
    );
  });

  it('enrolls a Service with no requested claims or redirected Inspect URL', async () => {
    const document = structuredClone(inspect.document);
    delete document.claims;
    const { finalUrl: _finalUrl, ...inspection } = inspect;
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    platformRecovery.notRecognized = true;
    platformRecovery.immediateSignResult = 'completed-without-context';
    await expect(
      __testing.runEnroll(context({ maxAttempts: 1, timeout: 1 }), inflow({ ...inspection, document }), storage),
    ).resolves.toEqual({ status: 'active' });
  });

  it.each([undefined, [], ['read']])(
    'passes grant scopes into the fetch approval context without inventing scopes: %j',
    async (requestedScopes) => {
      const original = fetchScenario.run;
      fetchScenario.run = async (rawInput) => {
        // The interception observes the actual options passed to the core fetch boundary.
        const input = rawInput as Parameters<typeof InflowCore.runAepFetch>[0];
        const provider = input.agentOptions.platformContextProvider;
        expect(
          await provider?.({
            identity,
            command: 'grant',
            grantType: 'api-key',
            serviceDid: identity.serviceDid,
            ...(requestedScopes === undefined ? {} : { requestedScopes }),
          }),
        ).toEqual({
          grant_type: 'api-key',
          ...(requestedScopes === undefined || requestedScopes.length === 0
            ? {}
            : { requested_scopes: requestedScopes }),
        });
        expect(
          await provider?.({ identity, command: 'authenticate', serviceDid: identity.serviceDid }),
        ).toBeUndefined();
        return original(rawInput);
      };
      await __testing.runFetch(
        {
          ...context({
            header: [],
            method: 'GET',
            maxRedirects: 5,
            maxResponseBytes: 1024,
            showBody: true,
            timeout: 30,
          }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        new MemoryStorage(),
      );
    },
  );

  it.each(['missing-approval', 'invalid-interval', 'non-error-status-failure', 'pending-after-approved'] as const)(
    'handles the fetch approval lifecycle: %s',
    async (scenario) => {
      const original = fetchScenario.run;
      vi.stubGlobal(
        'fetch',
        scenario === 'non-error-status-failure'
          ? vi.fn().mockRejectedValue('Status connection failed')
          : vi.fn(() => Promise.resolve(Response.json({ status: 'APPROVED' }))),
      );
      const continueSign = vi
        .fn<Parameters<NonNullable<AepAgent.AepAgentOptions['pendingSignResolver']>>[0]['continueSign']>()
        .mockResolvedValueOnce({ status: 'pending', retryAfterSeconds: 0.001 })
        .mockResolvedValue({ status: 'completed', clientAssertion: 'assertion' });
      fetchScenario.run = async (rawInput) => {
        // The interception exercises the CLI resolver supplied to the core, not a replacement resolver.
        const input = rawInput as Parameters<typeof InflowCore.runAepFetch>[0];
        await input.agentOptions.pendingSignResolver?.({
          claims: {
            iss: identity.agentDid,
            sub: identity.agentDid,
            aud: identity.serviceDid,
            iat: 1,
            exp: 301,
            jti: 'test',
            op: 'authenticate',
          },
          context: { command: 'authenticate', serviceDid: identity.serviceDid, signingAlgorithms: ['ES256'] },
          pending: {
            status: 'pending',
            retryAfterSeconds: scenario === 'invalid-interval' ? 0 : 0.001,
            ...(scenario === 'missing-approval' ? {} : { platformContext: { approval_id: 'approval-1' } }),
          },
          continueSign,
        });
        return original(rawInput);
      };
      const operation = __testing.runFetch(
        {
          ...context({
            header: [],
            method: 'GET',
            maxRedirects: 5,
            maxResponseBytes: 1024,
            showBody: true,
            timeout: 1,
          }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        new MemoryStorage(),
      );
      if (scenario === 'pending-after-approved') {
        await expect(operation).resolves.toMatchObject({ status: 200 });
        expect(continueSign).toHaveBeenCalledTimes(2);
      } else {
        await expect(operation).rejects.toThrow();
        expect(continueSign).not.toHaveBeenCalled();
      }
    },
  );
  it('falls back to a resource probe when optional OpenAPI discovery fails', async () => {
    const agent = await import('@aep-foundation/agent');
    vi.spyOn(agent, 'inspectOpenApiPolicy').mockRejectedValue(new Error('OpenAPI unavailable'));
    const result = await __testing.runInspect(
      { ...context({ timeout: 30, method: 'POST', data: '{}' }), agent: false, formatExplicit: false },
      inflow(),
    );
    expect(result).toMatchObject({ resource_authentication: { result: 'not-required', source: 'anonymous_probe' } });
    expect(probeScenario.calls).toBe(1);
    expect(rendering.present).toHaveBeenCalledOnce();
  });

  it('rejects an invalid Inspect reference before network discovery', async () => {
    const agent = await import('@aep-foundation/agent');
    vi.spyOn(agent, 'resolveServiceReference').mockImplementation(() => {
      throw new AepServiceReferenceError('Invalid Service');
    });
    await expect(__testing.runInspect(context({ timeout: 30 }), inflow())).rejects.toThrow('AEP_SERVICE_URL_INVALID');
    expect(probeScenario.calls).toBe(0);
  });

  it('rejects malformed Inspect request headers without probing the resource', async () => {
    await expect(
      __testing.runInspect(context({ timeout: 30, header: ['missing-separator'] }), inflow()),
    ).rejects.toThrow('INVALID_HEADER');
    expect(probeScenario.calls).toBe(0);
  });

  it('renders a missing Inspect endpoint for a human without requiring enrollment', async () => {
    const client = inflow();
    vi.spyOn(client.aep, 'inspect').mockRejectedValue(new AepInspectError('Missing', 'http_error', 404));
    expect(
      await __testing.runInspect({ ...context({ timeout: 30 }), agent: false, formatExplicit: false }, client),
    ).toMatchObject({ outcome: 'not-advertised', status: 404 });
    expect(rendering.present).toHaveBeenCalledOnce();
    expect(platformRecovery.approvalsCreated).toBe(0);
  });

  it.each(['missing-identity', 'unrecognized', 'no-grants'] as const)(
    'finishes the human view for %s without starting an approval',
    async (scenario) => {
      const storage = new MemoryStorage();
      storage.setApiKey('key');
      const persisted = new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' });
      if (scenario !== 'missing-identity') await persisted.identities().saveIdentity(identity);
      platformRecovery.notRecognized = scenario === 'unrecognized';
      const document = structuredClone(inspect.document);
      if (scenario === 'no-grants') delete document.commands.grant_types;
      const client = inflow({ ...inspect, document });
      const c = { ...context({ scope: [], maxAttempts: 1, timeout: 1 }), agent: false, formatExplicit: false };
      expect(await __testing.runGrant(c, client, storage)).toMatchObject({ granted: false });
      if (scenario === 'missing-identity') {
        expect(await __testing.runStatus(c, client, storage)).toMatchObject({ enrolled: false });
      }
      expect(rendering.present).toHaveBeenCalled();
      expect(platformRecovery.approvalsCreated).toBe(0);
    },
  );

  it.each(
    (['enroll', 'grant'] as const).flatMap((command) =>
      [
        { status: 'DECLINED', code: 'AEP_APPROVAL_DENIED' },
        { status: 'CANCELLED', code: 'APPROVAL_CANCELLED' },
        { status: 'PENDING', code: 'AEP_APPROVAL_TIMEOUT' },
      ].map((outcome) => ({ command, ...outcome })),
    ),
  )('does not issue credentials after human $command approval is $status', async ({ command, status, code }) => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' });
    if (command === 'grant') await persisted.identities().saveIdentity(identity);
    const approvalFetch = vi.fn(() => Promise.resolve(Response.json({ status })));
    vi.stubGlobal('fetch', approvalFetch);
    const c = {
      ...context({ scope: [], interval: 0.1, maxAttempts: 1, timeout: 1 }),
      agent: false,
      formatExplicit: false,
    };
    const rejected = expect(
      command === 'enroll' ? __testing.runEnroll(c, inflow(), storage) : __testing.runGrant(c, inflow(), storage),
    ).rejects.toThrow(code);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(persisted.credentials().listCredentials(identity.serviceDid)).toEqual([]);
    expect(rendering.present).not.toHaveBeenCalled();
    for (const call of rendering.render.mock.results) {
      if (call.type !== 'return') throw new Error('Rendering failed');
      expect(call.value.clear).toHaveBeenCalledOnce();
      expect(call.value.unmount).toHaveBeenCalledOnce();
    }
  });

  it.each([['mpp'], ['x402'], ['mpp', 'x402']])(
    'presents payment-required guidance after authentication without initiating payment: %j',
    async (...protocols) => {
      const fetchCall = vi.fn(() =>
        Promise.resolve({
          authentication: {
            method: 'credential',
            outcome: 'authenticated',
            credentialId: 'service-key',
            grantType: 'api-key',
          },
          body: 'Payment required',
          finalUrl: 'https://service.example/resource',
          redirected: false,
          requestedUrl: 'https://service.example/resource',
          responseSizeBytes: 16,
          status: 402,
          paymentRequired: { protocols },
        }),
      );
      fetchScenario.run = fetchCall;
      const frame = await __testing.runFetch(
        {
          ...context({
            header: [],
            maxRedirects: 5,
            maxResponseBytes: 1024,
            method: 'GET',
            showBody: true,
            timeout: 30,
          }),
          agent: false,
          formatExplicit: false,
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        new MemoryStorage(),
      );
      expect(frame).toMatchObject({
        status: 402,
        authentication: {
          method: 'credential',
          outcome: 'authenticated',
          credential_id: 'service-key',
          grant_type: 'api-key',
        },
        payment_required: { protocols },
      });
      expect(fetchCall).toHaveBeenCalledOnce();
      expect(rendering.present).toHaveBeenCalledOnce();
      expect(platformRecovery.approvalsCreated).toBe(0);
    },
  );

  it('retains unfamiliar claim names without offering an invented account URL', () => {
    const missing = __testing.commandError(new AepClaimRequirementsError(['custom.department']));
    expect(missing.details).toEqual({
      reason: 'account_information_missing',
      missing_claims: [{ label: 'custom.department', name: 'custom.department' }],
    });
    expect(missing).not.toHaveProperty('cta');
    expect(missing.message).not.toContain('undefined');
    const invalid = __testing.commandError(
      new AepClaimValuesError([{ path: 'custom.department', message: 'Expected string.' }]),
    );
    expect(invalid.details).toEqual({
      reason: 'account_information_invalid',
      issues: [
        {
          claim: 'custom.department',
          label: 'custom.department',
          path: 'custom.department',
          message: 'Expected string.',
        },
      ],
    });
    expect(invalid).not.toHaveProperty('cta');
    expect(invalid.message).not.toContain('undefined');
  });

  it.each([
    ['aep-challenge', 401, 'aep-authenticatable'],
    ['unrelated-authentication', 401, 'other-authentication-required'],
    ['http-response', 402, 'not-required'],
  ])(
    'reports anonymous probe classification %s without requesting credentials',
    async (classification, status, result) => {
      probeScenario.classification = classification;
      probeScenario.status = status;
      const storage = new MemoryStorage();
      const read = vi.spyOn(storage, 'getAepState');
      const frame = await __testing.runInspect(context({ timeout: 30 }), inflow(), storage);
      expect(frame).toMatchObject({ resource_authentication: { result, source: 'anonymous_probe', status } });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([null, {}, { required: 'contact.email' }, { required: [false, 1] }])(
    'does not turn malformed unsupported-claims metadata %j into account instructions',
    (unsupported_claims) => {
      const error = new AepCommandError('requirements', 400, {
        code: 'requirements_unmet',
        status: 400,
        title: 'Requirements unmet',
        type: 'urn:aep:error:requirements_unmet',
        unsupported_claims,
      });
      expect(__testing.commandError(error)).toEqual({
        code: 'AEP_REQUIREMENTS_UNMET',
        details: { requirements_pending: [], required_document_ids: [] },
        message:
          'The Service requires updated enrollment information or document acceptance.\n\nRun aep enroll for this Service to review and update enrollment. Then request Grant again when ready.',
        retryable: false,
      });
    },
  );

  it.each([
    { status: 'DECLINED', httpStatus: 200, code: 'AEP_APPROVAL_DENIED' },
    { status: 'PENDING', httpStatus: 503, code: 'AEP_APPROVAL_SERVER_ERROR' },
    { status: 'PENDING', httpStatus: 200, code: 'AEP_APPROVAL_TIMEOUT' },
    { status: 'CANCELLED', httpStatus: 200, code: 'APPROVAL_CANCELLED' },
  ])('preserves $code through the installed SDK signing resolver', async ({ status, httpStatus, code }) => {
    const actual = await vi.importActual<typeof AepAgent>('@aep-foundation/agent');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status }, { status: httpStatus }))),
    );
    const signer = vi.fn(() =>
      Promise.resolve({
        status: 'pending' as const,
        platformContext: { approval_id: 'approval-1' },
        retryAfterSeconds: 0.001,
      }),
    );
    fetchScenario.run = (rawInput) => {
      // runAepFetch is substituted only to exercise the CLI callback through the real SDK signing boundary.
      const input = rawInput as Parameters<typeof InflowCore.runAepFetch>[0];
      return actual.signClientAssertion({
        agentDid: identity.agentDid,
        command: 'authenticate',
        resource: 'https://service.example/resource',
        serviceDid: identity.serviceDid,
        signer,
        ...(input.agentOptions.pendingSignResolver === undefined
          ? {}
          : {
              pendingSignResolver: input.agentOptions.pendingSignResolver,
            }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    };
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    await expect(
      __testing.runFetch(
        {
          ...context({
            header: [],
            maxRedirects: 5,
            maxResponseBytes: 1024,
            method: 'GET',
            showBody: true,
            timeout: code === 'AEP_APPROVAL_TIMEOUT' ? 0.02 : 2,
          }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        storage,
      ),
    ).rejects.toThrow(code);
    expect(signer).toHaveBeenCalledOnce();
  });

  it.each(['enroll', 'grant'] as const)(
    'closes interactive %s progress and approval views after approval',
    async (command) => {
      const storage = new MemoryStorage();
      storage.setApiKey('key');
      if (command === 'grant') {
        const persisted = new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' });
        await persisted.identities().saveIdentity(identity);
      }
      const approvalFetch = vi.fn(() => Promise.resolve(Response.json({ status: 'APPROVED' })));
      vi.stubGlobal('fetch', approvalFetch);
      const c = {
        ...context({ scope: ['read'], interval: 0.01, maxAttempts: 1, timeout: 2 }),
        agent: false,
        formatExplicit: false,
      };
      const result = await (command === 'enroll'
        ? __testing.runEnroll(c, inflow(), storage)
        : __testing.runGrant(c, inflow(), storage));

      expect(result).toMatchObject(command === 'enroll' ? { status: 'active' } : { credential_id: 'credential-1' });
      expect(platformRecovery.approvalsCreated).toBe(1);
      expect(approvalFetch).toHaveBeenCalledOnce();
      expect(rendering.present).toHaveBeenCalledOnce();
      expect(
        rendering.render.mock.calls.some(
          ([element]) => isValidElement(element) && element.type === PendingApprovalView,
        ),
      ).toBe(true);
      for (const call of rendering.render.mock.results) {
        if (call.type !== 'return') throw new Error('Rendering failed');
        expect(call.value.clear).toHaveBeenCalledOnce();
        expect(call.value.unmount).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(['enroll', 'grant', 'fetch'] as const)(
    'cancels an interactive %s approval before closing the waiting view',
    async (command) => {
      const storage = new MemoryStorage();
      storage.setApiKey('key');
      if (command === 'grant') {
        const persisted = new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' });
        await persisted.identities().saveIdentity(identity);
      }
      const approvalFetch = vi.fn((_url: unknown, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'POST' ? new Response(null, { status: 204 }) : Response.json({ status: 'PENDING' }),
        ),
      );
      vi.stubGlobal('fetch', approvalFetch);
      const continueSign = vi.fn().mockRejectedValue(new Error('Cancelled approval must not continue signing'));
      if (command === 'fetch') {
        fetchScenario.run = async (rawInput) => {
          // The test interception receives the same options as the real core entry point.
          const input = rawInput as Parameters<typeof InflowCore.runAepFetch>[0];
          const resolver = input.agentOptions.pendingSignResolver;
          if (resolver === undefined) throw new Error('Missing approval resolver');
          return resolver({
            claims: {
              iss: identity.agentDid,
              sub: identity.agentDid,
              aud: identity.serviceDid,
              iat: 1,
              exp: 301,
              jti: 'grant-request',
              op: 'grant',
            },
            context: { command: 'grant', serviceDid: identity.serviceDid, signingAlgorithms: ['ES256'] },
            continueSign,
            pending: { platformContext: { approval_id: 'approval-1' }, retryAfterSeconds: 0.01, status: 'pending' },
          });
        };
      }
      const c = {
        ...context({ scope: ['read'], interval: 0.01, maxAttempts: 0, timeout: 2 }),
        agent: false,
        formatExplicit: false,
      };
      const operation =
        command === 'enroll'
          ? __testing.runEnroll(c, inflow(), storage)
          : command === 'grant'
            ? __testing.runGrant(c, inflow(), storage)
            : __testing.runFetch(
                {
                  ...c,
                  args: { resourceUrl: 'https://service.example/resource' },
                  options: {
                    header: [],
                    maxRedirects: 5,
                    maxResponseBytes: 1024,
                    method: 'GET',
                    showBody: true,
                    timeout: 2,
                  },
                },
                inflow(),
                storage,
              );
      const rejected = expect(operation).rejects.toThrow('APPROVAL_CANCELLED');
      try {
        await vi.waitFor(() =>
          expect(
            rendering.render.mock.calls.some(
              ([element]) => isValidElement(element) && element.type === PendingApprovalView,
            ),
          ).toBe(true),
        );
        const element = rendering.render.mock.calls.find(
          ([value]) => isValidElement(value) && value.type === PendingApprovalView,
        )?.[0];
        if (!isValidElement<{ onCancel: () => Promise<void> }>(element)) throw new Error('Missing approval view');
        await element.props.onCancel();
        await rejected;
        const cancellations = approvalFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
        expect(cancellations).toHaveLength(1);
        expect(String(cancellations[0]?.[0])).toBe('https://platform.example/v1/approvals/approval-1/cancel');
        expect(rendering.present).not.toHaveBeenCalled();
        expect(continueSign).not.toHaveBeenCalled();
        for (const call of rendering.render.mock.results) {
          if (call.type !== 'return') throw new Error('Rendering failed');
          expect(call.value.clear).toHaveBeenCalledOnce();
          expect(call.value.unmount).toHaveBeenCalledOnce();
        }
      } finally {
        await operation.catch(() => undefined);
      }
    },
  );

  it('routes real parsed command arguments through inspect, status, grant, fetch, and revoke', async () => {
    const storage = new MemoryStorage();
    storage.setAuth({
      access_token: 'test-platform-token',
      refresh_token: 'test-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    await new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' })
      .identities()
      .saveIdentity(identity);
    platformRecovery.immediateSignResult = 'string';
    const cli = createAepCli(inflow(), storage);
    const execute = async (args: string[]) => {
      const output: string[] = [];
      const exit = vi.fn();
      await cli.serve([...args, '--format', 'json'], {
        exit,
        stdout: (chunk) => {
          output.push(chunk);
        },
      });
      expect(exit, output.join('')).not.toHaveBeenCalled();
      const text = output.join('');
      expect(text).not.toContain('immediate-assertion');
      return JSON.parse(text) as Record<string, unknown>;
    };
    expect(await execute(['inspect', 'service.example', '--method', 'GET'])).toMatchObject({ schema_version: 1 });
    expect(await execute(['enroll', 'service.example'])).toMatchObject({ status: 'active' });
    expect(
      await execute(['grant', 'service.example', '--grant-type', 'oauth-bearer', '--scope', 'read']),
    ).toMatchObject({ granted: true, grant_type: 'oauth-bearer' });
    expect(await execute(['status', 'service.example'])).toMatchObject({ service: { status: 'active' } });
    const fetch = vi.fn(fetchScenario.run);
    fetchScenario.run = fetch;
    expect(
      await execute([
        'fetch',
        'https://service.example/resource',
        '--method',
        'POST',
        '--data',
        '{"q":"test"}',
        '--credential-id',
        'credential-1',
      ]),
    ).toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        body: '{"q":"test"}',
        credentialId: 'credential-1',
        url: 'https://service.example/resource',
      }),
    );
    expect(await execute(['revoke', 'service.example', '--credential-id', 'credential-1'])).toMatchObject({
      revoked: true,
      credential_id: 'credential-1',
    });
    expect(
      await new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' })
        .credentials()
        .listCredentials(identity.serviceDid),
    ).toEqual([]);
  });

  it('registers the public AEP command group', async () => {
    const cli = createAepCli(inflow(), new MemoryStorage());
    const output: string[] = [];
    const exit = vi.fn();

    await cli.serve(['--help'], {
      exit,
      stdout: (chunk) => {
        output.push(chunk);
      },
    });

    const help = output.join('');
    expect(exit).not.toHaveBeenCalled();
    for (const command of ['document', 'inspect', 'enroll', 'fetch', 'status', 'grant', 'revoke']) {
      expect(help).toContain(command);
    }
  });

  it('passes persistent caching through the standalone Inspect helper', async () => {
    const cache = { delete: vi.fn(), get: vi.fn(), set: vi.fn() };
    const client = inflow() as unknown as { aep: { inspect: (options: unknown) => typeof inspect } };
    const inspectCall = vi.spyOn(client.aep, 'inspect');

    await expect(__testing.inspected(client as never, 'service.example', 30, cache)).resolves.toBe(inspect);
    expect(inspectCall).toHaveBeenCalledWith(expect.objectContaining({ publicDocumentCache: cache }));
    await expect(__testing.inspected(client as never, 'service.example', 0, cache)).rejects.toThrow(
      'Inspect timeout must be between 1 and 300 seconds.',
    );
  });

  it('supplies an existing persistent Inspect cache to the Inspect command', async () => {
    const backing = new MemoryStorage();
    const persisted = new AepStorage(backing, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await persisted.inspectCache().set('https://service.example/', {
      ...inspect,
      cachedAt: '2026-01-01T00:00:00.000Z',
    });
    const client = inflow() as unknown as { aep: { inspect: (options: unknown) => typeof inspect } };
    const inspectCall = vi.spyOn(client.aep, 'inspect');

    await __testing.runInspect(context({ timeout: 30 }), client as never, backing);

    const options = inspectCall.mock.calls[0]?.[0];
    expect(typeof options === 'object' && options !== null && 'publicDocumentCache' in options).toBe(true);
  });

  it.each([['inspect'], ['inspect', 'enroll', 'status'], ['inspect', 'enroll', 'grant', 'revoke', 'status']] as const)(
    'resolves only advertised AEP commands: %j',
    async (...supported) => {
      const client = inflow();
      const advertised: InspectServiceResult = {
        ...inspect,
        document: {
          ...inspect.document,
          commands: { supported: [...supported] },
        },
      };
      const commandUrl = vi.spyOn(advertised, 'commandUrl');
      vi.spyOn(client.aep, 'inspect').mockResolvedValue(advertised);
      const result = await __testing.runInspect(context({ timeout: 30 }), client);
      const commands = supported.filter((command) => command !== 'inspect');
      expect(result['resolved']).toEqual({
        service_url: 'https://service.example',
        ...Object.fromEntries(commands.map((command) => [command, `https://service.example/aep/${command}`])),
      });
      expect(commandUrl.mock.calls.map(([command]) => command)).toEqual(commands);
    },
  );

  it('uses definitive OpenAPI Inspect policy without probing the protected resource', async () => {
    openApiScenario.policy = {
      freshness: 'fresh',
      matchedOperation: { method: 'GET', pathTemplate: '/resource' },
      methods: ['aep-jwt'],
      source: 'openapi',
      state: 'required',
    };

    const result = await __testing.runInspect(context({ method: 'GET', timeout: 30 }), inflow(), new MemoryStorage());

    expect(probeScenario.calls).toBe(0);
    expect(result).toMatchObject({
      resource_authentication: {
        openapi: {
          accepted_methods: ['aep-jwt'],
          freshness: 'fresh',
          matched_operation: { method: 'GET', path_template: '/resource' },
          state: 'required',
        },
        result: 'aep-authenticatable',
        source: 'openapi',
      },
    });
  });

  it('reports public OpenAPI operations without contacting the resource or reading credentials', async () => {
    openApiScenario.policy = { freshness: 'fetched', methods: [], source: 'openapi', state: 'public' };
    const storage = new MemoryStorage();
    const readCredentials = vi.spyOn(storage, 'getAepState');
    const result = await __testing.runInspect(context({ method: 'POST', timeout: 30 }), inflow(), storage);
    expect(result).toMatchObject({
      resource_authentication: { result: 'not-required', source: 'openapi', openapi: { state: 'public' } },
    });
    expect(probeScenario.calls).toBe(0);
    expect(readCredentials).not.toHaveBeenCalled();
  });

  it.each(['Missing separator', ': missing-name', 'X-Test: '])(
    'rejects malformed inspection headers before probing: %s',
    async (header) => {
      await expect(__testing.runInspect(context({ header: [header], timeout: 30 }), inflow())).rejects.toThrow(
        'INVALID_HEADER',
      );
      expect(probeScenario.calls).toBe(0);
    },
  );

  it('presents strict trailing-slash suggestions while preserving anonymous probe fallback', async () => {
    openApiScenario.policy = {
      freshness: 'fresh',
      methods: [],
      source: 'openapi',
      state: 'fallback',
      strictSlashSuggestion: '/resource',
    };

    const result = await __testing.runInspect(
      { ...context({ method: 'GET', timeout: 30 }), args: { serviceReference: 'service.example/resource/' } },
      inflow(),
      new MemoryStorage(),
    );

    expect(probeScenario.calls).toBe(1);
    expect(result).toMatchObject({
      resource_authentication: {
        openapi: {
          freshness: 'fresh',
          state: 'fallback',
          strict_slash_suggestion: '/resource',
        },
        result: 'not-required',
        source: 'anonymous_probe',
        status: 204,
      },
    });
  });

  it('maps Inspect and unexpected failures to stable command errors', () => {
    expect(__testing.commandError(new AepServiceReferenceError('invalid'))).toEqual({
      code: 'AEP_SERVICE_URL_INVALID',
      exitCode: 2,
      message: 'The AEP Service reference is invalid.',
    });
    expect(
      __testing.commandError(new AepInspectError('Response exceeds the size limit.', 'response_too_large')),
    ).toEqual({
      code: 'AEP_INSPECT_RESPONSE_TOO_LARGE',
      message: 'Response exceeds the size limit.',
      retryable: true,
    });
    const identityMismatch = new AepInspectError('\u001b[31mService identity does not match.\u001b[0m');
    Object.defineProperty(identityMismatch, 'code', { value: 'service_identity_mismatch' });
    expect(__testing.commandError(identityMismatch)).toEqual({
      code: 'AEP_SERVICE_IDENTITY_MISMATCH',
      message: 'Service identity does not match.',
      retryable: false,
    });
    expect(__testing.commandError(new Error('failed'))).toEqual({
      code: 'AEP_INTERNAL_ERROR',
      message: 'The AEP command failed unexpectedly.',
    });
    const requirementContext = {
      accountUrl: 'https://app.inflowpay.ai/user/',
      serviceReference: 'https://service.example',
    };
    expect(
      __testing.commandError(new AepClaimRequirementsError(['contact.address.primary']), requirementContext),
    ).toEqual({
      code: 'AEP_REQUIREMENTS_UNMET',
      cta: {
        commands: [
          {
            command: 'aep enroll https://service.example',
            description: 'Retry enrollment',
          },
        ],
        description: 'After updating your account:',
      },
      details: {
        missing_claims: [{ label: 'Primary address', name: 'contact.address.primary' }],
        reason: 'account_information_missing',
        resolution: { action: 'update_account', url: 'https://app.inflowpay.ai/user/' },
      },
      message:
        'The Service requires information that is not configured in your InFlow account.\n\n' +
        'Missing information\n' +
        '  Primary address  contact.address.primary\n\n' +
        'Update your account\n' +
        '  https://app.inflowpay.ai/user/',
      retryable: false,
      title: 'Enrollment needs account information',
    });
    expect(
      __testing.commandError(
        new AepClaimValuesError([
          { path: '$.contact.mobile', message: 'Expected string to match the AEP mobile format.' },
          { path: '$.contact.address.primary.first_name', message: 'Expected at least 1 character(s).' },
        ]),
        requirementContext,
      ),
    ).toEqual({
      code: 'AEP_REQUIREMENTS_UNMET',
      cta: {
        commands: [
          {
            command: 'aep enroll https://service.example',
            description: 'Retry enrollment',
          },
        ],
        description: 'After updating your account:',
      },
      details: {
        issues: [
          {
            claim: 'contact.mobile',
            label: 'Mobile phone number',
            message: 'Expected string to match the AEP mobile format.',
            path: 'contact.mobile',
          },
          {
            claim: 'contact.address.primary',
            label: 'Recipient first name',
            message: 'Expected at least 1 character(s).',
            path: 'contact.address.primary.first_name',
          },
        ],
        reason: 'account_information_invalid',
        resolution: { action: 'update_account', url: 'https://app.inflowpay.ai/user/' },
      },
      message:
        'Some information approved for this Service does not meet the required format.\n\n' +
        'Information to review\n' +
        '  Mobile phone number\n' +
        '  Problem    Expected string to match the AEP mobile format.\n' +
        '  AEP field  contact.mobile\n\n' +
        '  Recipient first name\n' +
        '  Problem    Expected at least 1 character(s).\n' +
        '  AEP field  contact.address.primary.first_name\n\n' +
        'Review your account\n' +
        '  https://app.inflowpay.ai/user/',
      retryable: false,
      title: 'Enrollment needs corrected account information',
    });
    expect(__testing.commandError(new TypeError('Invalid AEP Grant response.'))).toEqual({
      code: 'AEP_GRANT_RESPONSE_INVALID',
      message: 'The Service returned an invalid AEP Grant response.',
    });
    expect(
      __testing.commandError(new SecureStorageError('secure_storage_secret_missing', 'The InFlow vault is locked.')),
    ).toEqual({
      code: 'VAULT_LOCKED',
      message: 'The InFlow vault is locked.',
    });
    expect(
      __testing.commandError(new SecureStorageError('vault_not_initialized', 'The InFlow vault is not initialized.')),
    ).toEqual({
      code: 'VAULT_NOT_INITIALIZED',
      message: 'The InFlow vault is not initialized.',
    });
    expect(__testing.commandError(new SecureStorageError('secure_storage_unavailable', 'Unavailable.'))).toEqual({
      code: 'secure_storage_unavailable',
      message: 'Unavailable.',
    });
    expect(
      __testing.commandError(
        new AepCommandError('requirements', 400, {
          code: 'requirements_unmet',
          status: 400,
          title: 'Requirements unmet',
          type: 'urn:aep:error:requirements_unmet',
          unsupported_claims: { required: ['organization.procurement.department'] },
        }),
      ),
    ).toEqual({
      code: 'AEP_REQUIREMENTS_UNMET',
      details: {
        reason: 'unsupported_claims',
        resolution: { action: 'service_update_required' },
        unsupported_claims: ['organization.procurement.department'],
      },
      message:
        'This Service requires information that InFlow does not currently support.\n\n' +
        'Unsupported requirements\n' +
        '  organization.procurement.department\n\n' +
        'Changing your account will not resolve this requirement. ' +
        'The Service must request supported AEP claims before enrollment can continue.',
      retryable: false,
      title: 'Enrollment requirements are not supported',
    });
    expect(
      __testing.commandError(
        new AepCommandError('requirements', 400, {
          code: 'requirements_unmet',
          status: 400,
          title: 'Requirements unmet',
          type: 'urn:aep:error:requirements_unmet',
        }),
      ),
    ).toEqual({
      code: 'AEP_REQUIREMENTS_UNMET',
      details: { requirements_pending: [], required_document_ids: [] },
      message:
        'The Service requires updated enrollment information or document acceptance.\n\nRun aep enroll for this Service to review and update enrollment. Then request Grant again when ready.',
      retryable: false,
    });
    expect(
      __testing.commandError(
        new AepCommandError('denied', 403, {
          code: 'authorization_denied',
          status: 403,
          title: 'Authorization denied',
          type: 'urn:aep:error:authorization_denied',
        }),
      ),
    ).toEqual({ code: 'AEP_APPROVAL_DENIED', message: 'The InFlow approval was denied.' });
    expect(__testing.commandError(new AepCommandError('failed', 500))).toEqual({
      code: 'AEP_SIGN_FAILED',
      message: 'The AEP command failed.',
    });
  });

  it('validates AEP helper frames, storage, approval responses, and cancellation', async () => {
    expect(__testing.paymentRequiredFrame(undefined, 'https://service.example/resource')).toBeUndefined();
    expect(
      __testing.paymentRequiredFrame({ protocols: ['mpp', 'x402'] }, 'https://service.example/a resource'),
    ).toEqual({
      commands: {
        mpp: "mpp pay 'https://service.example/a resource'",
        x402: "x402 pay 'https://service.example/a resource'",
      },
      protocols: ['mpp', 'x402'],
    });
    expect(() => __testing.stateStorage({} as never)).toThrow('AEP storage is unavailable.');

    const clear = vi.fn();
    const unmount = vi.fn();
    __testing.closeAepRenderer(undefined);
    __testing.closeAepRenderer({ clear, unmount });
    expect(clear).toHaveBeenCalledOnce();
    expect(unmount).toHaveBeenCalledOnce();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('failed', { status: 500 }))),
    );
    await expect(__testing.approvalStatus(inflow(), 'approval-1')).rejects.toThrow('Approval status request failed.');

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
    await expect(__testing.approvalStatus(inflow(), 'approval-1')).rejects.toThrow(
      'Approval status response is invalid.',
    );

    const cancelFetch = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', cancelFetch);
    await expect(__testing.cancelApproval(inflow(), 'approval-1')).rejects.toThrow('offline');
    expect(cancelFetch).toHaveBeenCalledOnce();

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(__testing.approvalSleep(1, [alreadyAborted.signal])).rejects.toThrow('');
    const controller = new AbortController();
    const sleeping = __testing.approvalSleep(10_000, [controller.signal]);
    controller.abort();
    await expect(sleeping).rejects.toThrow('');
  });

  it('returns the complete anonymous fetch JSON contract without requiring a session', async () => {
    const result = await __testing.runFetch(
      {
        ...context({
          header: ['X-Test: one'],
          maxRedirects: 5,
          maxResponseBytes: 1024,
          method: 'GET',
          showBody: true,
          timeout: 30,
        }),
        args: { resourceUrl: 'https://service.example/resource' },
      },
      inflow(),
      new MemoryStorage(),
    );
    expect(result).toEqual({
      authentication: { method: null, outcome: 'not-required' },
      body: 'anonymous',
      content_type: 'text/plain',
      final_url: 'https://service.example/resource',
      redirects: { occurred: false },
      requested_url: 'https://service.example/resource',
      response_size_bytes: 9,
      status: 200,
    });
  });

  it('forwards an explicit credential type and output path and reports the saved response without a body', async () => {
    const fetchCall = vi.fn(() =>
      Promise.resolve({
        authentication: { method: null, outcome: 'not-required' },
        finalUrl: 'https://service.example/resource',
        requestedUrl: 'https://service.example/resource',
        redirected: false,
        responseSizeBytes: 9,
        bodySizeBytes: 9,
        status: 200,
        outputSavedTo: '/tmp/aep-response.txt',
      }),
    );
    fetchScenario.run = fetchCall;
    const frame = await __testing.runFetch(
      {
        ...context({
          credentialId: 'key-1',
          grantType: 'api-key',
          outputFile: '/tmp/aep-response.txt',
          header: [],
          method: 'GET',
          maxRedirects: 5,
          maxResponseBytes: 1024,
          showBody: true,
          timeout: 30,
        }),
        args: { resourceUrl: 'https://service.example/resource' },
      },
      inflow(),
      new MemoryStorage(),
    );
    expect(fetchCall).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: 'key-1',
        grantType: 'api-key',
        outputFile: '/tmp/aep-response.txt',
      }),
    );
    expect(frame).toHaveProperty('output_saved_to', '/tmp/aep-response.txt');
    expect(frame).not.toHaveProperty('body');
  });

  it.each([
    { name: 'JSON body', data: '{ "query": "café" }\n', header: [], expected: { 'Content-Type': 'application/json' } },
    { name: 'empty body', data: '', header: [], expected: { 'Content-Type': 'application/json' } },
    { name: 'absent body', data: undefined, header: ['X-Test: one'], expected: { 'X-Test': 'one' } },
    {
      name: 'lowercase override',
      data: 'plain text',
      header: ['content-type: text/plain'],
      expected: { 'content-type': 'text/plain' },
    },
    {
      name: 'mixed-case override',
      data: 'a=b',
      header: ['cOnTeNt-TyPe: application/x-www-form-urlencoded'],
      expected: { 'cOnTeNt-TyPe': 'application/x-www-form-urlencoded' },
    },
  ])('normalizes standalone fetch headers for $name without changing the body', async ({ data, header, expected }) => {
    const fetchCall = vi.fn(fetchScenario.run);
    fetchScenario.run = fetchCall;
    await __testing.runFetch(
      {
        ...context({
          data,
          header,
          maxRedirects: 5,
          maxResponseBytes: 1024,
          method: 'POST',
          showBody: true,
          timeout: 30,
        }),
        args: { resourceUrl: 'https://service.example/resource' },
      },
      inflow(),
      new MemoryStorage(),
    );
    expect(fetchCall).toHaveBeenCalledWith(expect.objectContaining({ headers: expected }));
    if (data === undefined) expect(fetchCall.mock.calls[0]?.[0]).not.toHaveProperty('body');
    else expect(fetchCall).toHaveBeenCalledWith(expect.objectContaining({ body: data }));
  });

  it('rejects an explicit empty content type without replacing it or dispatching', async () => {
    const fetchCall = vi.fn(fetchScenario.run);
    fetchScenario.run = fetchCall;
    await expect(
      __testing.runFetch(
        {
          ...context({
            data: '{}',
            header: ['Content-Type:'],
            maxRedirects: 5,
            maxResponseBytes: 1024,
            method: 'POST',
            showBody: true,
            timeout: 30,
          }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        new MemoryStorage(),
      ),
    ).rejects.toThrow('INVALID_HEADER');
    expect(fetchCall).not.toHaveBeenCalled();
  });

  it('supplies InFlow Grant context through the generic Agent provider', async () => {
    fetchScenario.run = async (rawInput: unknown) => {
      const input = rawInput as {
        agentOptions: {
          platformContextProvider(input: {
            command: 'grant';
            grantType: string;
            identity: typeof identity;
            requestedScopes: string[];
            serviceDid: string;
          }): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
        };
      };
      await expect(
        Promise.resolve(
          input.agentOptions.platformContextProvider({
            command: 'grant',
            grantType: 'api-key',
            identity,
            requestedScopes: ['read:resource'],
            serviceDid: identity.serviceDid,
          }),
        ),
      ).resolves.toEqual({ grant_type: 'api-key', requested_scopes: ['read:resource'] });
      return {
        authentication: { method: null, outcome: 'not-required' },
        body: 'anonymous',
        finalUrl: 'https://service.example/resource',
        redirected: false,
        requestedUrl: 'https://service.example/resource',
        responseSizeBytes: 9,
        status: 200,
      };
    };

    await __testing.runFetch(
      {
        ...context({
          header: [],
          maxRedirects: 5,
          maxResponseBytes: 1024,
          method: 'GET',
          showBody: true,
          timeout: 30,
        }),
        args: { resourceUrl: 'https://service.example/resource' },
      },
      inflow(),
      new MemoryStorage(),
    );
  });

  it('validates fetch bounds and header syntax with stable errors', async () => {
    const base = {
      ...context({ header: [], maxRedirects: 5, maxResponseBytes: 1024, method: 'GET', showBody: true, timeout: 0 }),
      args: { resourceUrl: 'https://service.example/resource' },
    };
    await expect(__testing.runFetch(base, inflow(), new MemoryStorage())).rejects.toThrow('AEP_FETCH_TIMEOUT_INVALID');
    await expect(
      __testing.runFetch(
        { ...base, options: { ...base.options, header: ['invalid'], timeout: 30 } },
        inflow(),
        new MemoryStorage(),
      ),
    ).rejects.toThrow('INVALID_HEADER');
  });

  it.each([
    [new AepFetchError('AEP_RESPONSE_TOO_LARGE', 'too large'), 'AEP_RESPONSE_TOO_LARGE'],
    [new SecureStorageError('vault_locked', 'Locked'), 'VAULT_LOCKED'],
  ] as const)('maps core fetch failures to their typed CLI code: %s', async (failure, code) => {
    fetchScenario.run = () => Promise.reject(failure);
    await expect(
      __testing.runFetch(
        {
          ...context({ header: [], maxRedirects: 5, maxResponseBytes: 1, method: 'GET', showBody: true, timeout: 30 }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        new MemoryStorage(),
      ),
    ).rejects.toThrow(code);
  });

  it.each(['not_recognized', 'agent_identity_not_found'])(
    'maps %s Fetch failures to the not-enrolled error',
    async (code) => {
      fetchScenario.run = () => {
        return Promise.reject(
          new AepCommandError('not enrolled', 404, {
            code,
            status: 404,
            title: 'Not recognized',
            type: `urn:aep:error:${code}`,
          }),
        );
      };
      await expect(
        __testing.runFetch(
          {
            ...context({
              header: [],
              maxRedirects: 5,
              maxResponseBytes: 1024,
              method: 'GET',
              showBody: true,
              timeout: 30,
            }),
            args: { resourceUrl: 'https://service.example/resource' },
          },
          inflow(),
          new MemoryStorage(),
        ),
      ).rejects.toThrow('AEP_NOT_ENROLLED');
    },
  );

  it('projects binary and saved response attachments', async () => {
    fetchScenario.run = () =>
      Promise.resolve({
        authentication: { method: null, outcome: 'not-required' },
        bodyBase64: 'AAE=',
        bodySizeBytes: 2,
        finalUrl: 'https://service.example/resource',
        outputSavedTo: '/tmp/resource.bin',
        redirected: true,
        requestedUrl: 'https://service.example/resource',
        responseSizeBytes: 2,
        status: 200,
      });
    await expect(
      __testing.runFetch(
        {
          ...context({
            header: [],
            maxRedirects: 5,
            maxResponseBytes: 1024,
            method: 'GET',
            showBody: true,
            timeout: 30,
          }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        new MemoryStorage(),
      ),
    ).resolves.toMatchObject({
      body_base64: 'AAE=',
      output_saved_to: '/tmp/resource.bin',
      redirects: { occurred: true },
    });
  });

  it('uses the SDK pending resolver for approved authenticate signing', async () => {
    platformRecovery.identity = identity;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))),
    );
    fetchScenario.run = async (rawInput: unknown) => {
      const input = rawInput as {
        agentOptions: {
          credentialStore: {
            deleteCredential(serviceDid: string, credentialId: string): Promise<void>;
            findCredential(serviceDid: string, credentialId: string): Promise<unknown>;
            findUsableCredential(serviceDid: string): Promise<unknown>;
            listCredentials(serviceDid: string): Promise<unknown>;
            saveCredential(record: unknown): Promise<unknown>;
          };
          identityProvider: {
            findIdentityByServiceDid(serviceDid: string): Promise<unknown>;
            getOrCreateIdentity(input: unknown): Promise<unknown>;
            signerFor(identity: unknown): Promise<unknown>;
          };
          identityStore: {
            findByServiceDid(serviceDid: string): Promise<unknown>;
            saveIdentity(identity: unknown): Promise<unknown>;
          };
          inspectCache: {
            delete(serviceUrl: string): Promise<void>;
            get(serviceUrl: string): Promise<unknown>;
            set(serviceUrl: string, result: unknown): Promise<void>;
          };
          pendingSignResolver: (input: {
            continueSign(): Promise<{ clientAssertion: string; status: 'completed' }>;
            pending: { platformContext: Record<string, unknown>; retryAfterSeconds: number; status: 'pending' };
          }) => Promise<unknown>;
        };
      };
      await input.agentOptions.identityProvider.getOrCreateIdentity({
        inspect: inspect.document,
        serviceDid: identity.serviceDid,
        serviceUrl: 'https://service.example',
      });
      expect(await input.agentOptions.identityProvider.findIdentityByServiceDid(identity.serviceDid)).toEqual(identity);
      await input.agentOptions.identityProvider.signerFor(identity);
      await input.agentOptions.identityStore.saveIdentity(identity);
      await input.agentOptions.identityStore.findByServiceDid(identity.serviceDid);
      await input.agentOptions.inspectCache.set('https://service.example/', {
        ...inspect,
        cachedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(await input.agentOptions.inspectCache.get('https://service.example/')).toMatchObject({
        cachedAt: '2026-01-01T00:00:00.000Z',
      });
      await input.agentOptions.inspectCache.delete('https://service.example/');
      const record = {
        credential: { access_token: 'secret', credential_id: 'credential-1', expires_at: '2999-01-01T00:00:00Z' },
        credentialId: 'credential-1',
        expiresAt: '2999-01-01T00:00:00Z',
        grantType: 'oauth-bearer',
        issuedAt: '2026-01-01T00:00:00Z',
        serviceDid: identity.serviceDid,
      };
      await input.agentOptions.credentialStore.saveCredential(record);
      await input.agentOptions.credentialStore.findCredential(identity.serviceDid, 'credential-1');
      await input.agentOptions.credentialStore.findUsableCredential(identity.serviceDid);
      await input.agentOptions.credentialStore.listCredentials(identity.serviceDid);
      await input.agentOptions.credentialStore.deleteCredential(identity.serviceDid, 'credential-1');
      const completed = await input.agentOptions.pendingSignResolver({
        continueSign: () => Promise.resolve({ clientAssertion: 'jwt', status: 'completed' }),
        pending: { platformContext: { approval_id: 'approval-1' }, retryAfterSeconds: 1, status: 'pending' },
      });
      expect(completed).toMatchObject({ status: 'completed' });
      return {
        authentication: {
          credentialId: 'credential-1',
          grantType: 'oauth-bearer',
          method: 'credential',
          operation: 'grant',
          outcome: 'authenticated',
        },
        bodySizeBytes: 0,
        finalUrl: 'https://service.example/resource',
        redirected: false,
        requestedUrl: 'https://service.example/resource',
        responseSizeBytes: 0,
        serviceDid: 'did:web:service.example',
        status: 204,
      };
    };
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    await expect(
      __testing.runFetch(
        {
          ...context({
            header: [],
            maxRedirects: 5,
            maxResponseBytes: 1024,
            method: 'GET',
            showBody: true,
            timeout: 30,
          }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        storage,
      ),
    ).resolves.toMatchObject({
      authentication: {
        credential_id: 'credential-1',
        grant_type: 'oauth-bearer',
        method: 'credential',
        operation: 'grant',
        outcome: 'authenticated',
      },
      service_did: 'did:web:service.example',
      status: 204,
    });
  });

  it.each([
    ['DECLINED', 'AEP_APPROVAL_DENIED'],
    ['CANCELLED', 'APPROVAL_CANCELLED'],
  ])('maps %s pending Sign outcomes', async (status, code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status }), { status: 200 }))),
    );
    fetchScenario.run = async (rawInput: unknown) => {
      const input = rawInput as {
        agentOptions: {
          pendingSignResolver: (input: {
            continueSign(): Promise<never>;
            pending: { platformContext: Record<string, unknown>; retryAfterSeconds: number; status: 'pending' };
          }) => Promise<unknown>;
        };
      };
      return input.agentOptions.pendingSignResolver({
        continueSign: () => Promise.reject(new Error('must not continue')),
        pending: { platformContext: { approval_id: 'approval-1' }, retryAfterSeconds: 1, status: 'pending' },
      });
    };
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    await expect(
      __testing.runFetch(
        {
          ...context({
            header: [],
            maxRedirects: 5,
            maxResponseBytes: 1024,
            method: 'GET',
            showBody: true,
            timeout: 30,
          }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        storage,
      ),
    ).rejects.toThrow(code);
  });

  it('maps approval server failures without calling continuation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('failed', { status: 500 }))),
    );
    fetchScenario.run = async (rawInput: unknown) => {
      const input = rawInput as {
        agentOptions: {
          pendingSignResolver: (input: {
            continueSign(): Promise<never>;
            pending: { platformContext: Record<string, unknown>; retryAfterSeconds: number; status: 'pending' };
          }) => Promise<unknown>;
        };
      };
      return input.agentOptions.pendingSignResolver({
        continueSign: () => Promise.reject(new Error('must not continue')),
        pending: { platformContext: { approval_id: 'approval-1' }, retryAfterSeconds: 1, status: 'pending' },
      });
    };
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    await expect(
      __testing.runFetch(
        {
          ...context({
            header: [],
            maxRedirects: 5,
            maxResponseBytes: 1024,
            method: 'GET',
            showBody: true,
            timeout: 30,
          }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        storage,
      ),
    ).rejects.toThrow('AEP_APPROVAL_SERVER_ERROR');
  });
  it('maps a stalled approval status request to the approval timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        });
      }),
    );
    fetchScenario.run = async (rawInput: unknown) => {
      const input = rawInput as {
        agentOptions: {
          pendingSignResolver: (input: {
            continueSign(): Promise<never>;
            pending: { platformContext: Record<string, unknown>; retryAfterSeconds: number; status: 'pending' };
          }) => Promise<unknown>;
        };
      };
      return input.agentOptions.pendingSignResolver({
        continueSign: () => Promise.reject(new Error('must not continue')),
        pending: { platformContext: { approval_id: 'approval-1' }, retryAfterSeconds: 1, status: 'pending' },
      });
    };
    const storage = new MemoryStorage();
    storage.setApiKey('key');

    await expect(
      __testing.runFetch(
        {
          ...context({
            header: [],
            maxRedirects: 5,
            maxResponseBytes: 1024,
            method: 'GET',
            showBody: true,
            timeout: 0.005,
          }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        storage,
      ),
    ).rejects.toThrow('AEP_APPROVAL_TIMEOUT');
  });

  it('maps a cancelled approval status request to cancellation', async () => {
    fetchScenario.run = async (rawInput: unknown) => {
      const input = rawInput as {
        agentOptions: {
          pendingSignResolver: (input: {
            continueSign(): Promise<never>;
            pending: { platformContext: Record<string, unknown>; retryAfterSeconds: number; status: 'pending' };
            signal: AbortSignal;
          }) => Promise<unknown>;
        };
      };
      const controller = new AbortController();
      controller.abort();
      return input.agentOptions.pendingSignResolver({
        continueSign: () => Promise.reject(new Error('must not continue')),
        pending: { platformContext: { approval_id: 'approval-1' }, retryAfterSeconds: 1, status: 'pending' },
        signal: controller.signal,
      });
    };
    const storage = new MemoryStorage();
    storage.setApiKey('key');

    await expect(
      __testing.runFetch(
        {
          ...context({
            header: [],
            maxRedirects: 5,
            maxResponseBytes: 1024,
            method: 'GET',
            showBody: true,
            timeout: 30,
          }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        storage,
      ),
    ).rejects.toThrow('APPROVAL_CANCELLED');
  });

  it('sorts stored credentials and reports optional metadata without exposing credential values', async () => {
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' });
    await persisted.identities().saveIdentity(identity);
    for (const credentialId of ['z', 'a']) {
      await persisted.credentials().saveCredential({
        credential: { api_key: `secret-${credentialId}`, ...(credentialId === 'a' ? { scopes: ['wallet:read'] } : {}) },
        credentialId,
        grantType: 'api-key',
        issuedAt: '2026-01-01T00:00:00Z',
        serviceDid: identity.serviceDid,
      });
    }
    platformRecovery.immediateSignResult = 'string';
    const result = await __testing.runStatus(context(), inflow(), storage);
    expect(result).toMatchObject({
      local: {
        grants: [
          { credential_id: 'a', scopes: ['wallet:read'], status: 'active', usable: true },
          { credential_id: 'z', scopes: [], status: 'active', usable: true },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(JSON.stringify(result)).not.toContain('expires_at');
    expect(platformRecovery.approvalsCreated).toBe(0);
  });

  it('includes cache metadata and resolves only commands advertised by the Service', async () => {
    const result: InspectServiceResult = {
      ...inspect,
      cacheControl: 'max-age=300',
      etag: '"revision-one"',
      document: { ...inspect.document, commands: { supported: ['inspect', 'status'] } },
    };
    const frame = await __testing.runInspect(context({ timeout: 30 }), inflow(result));
    expect(frame).toMatchObject({
      response: { cache_control: 'max-age=300', etag: '"revision-one"' },
      resolved: { status: 'https://service.example/aep/status' },
    });
    expect(frame['resolved']).not.toHaveProperty('grant');
    expect(frame['resolved']).not.toHaveProperty('enroll');
    expect(frame['resolved']).not.toHaveProperty('revoke');
  });

  it.each([0, -1, 901])('rejects an invalid grant approval timeout before initiating approval: %s', async (timeout) => {
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    await expect(__testing.runGrant(context({ scope: [], timeout }), inflow(), storage)).rejects.toThrow(
      'AEP_INTERNAL_ERROR',
    );
    expect(platformRecovery.approvalsCreated).toBe(0);
    expect(storage.getAepState()).toBeNull();
  });

  it.each([true, false].flatMap((agent) => [true, false].map((cache) => ({ agent, cache }))))(
    'runs inspect, enrollment, status, grant, and revoke (agent $agent, public cache $cache)',
    async ({ agent, cache }) => {
      const commandContext = (options: Record<string, unknown> = {}) => ({
        ...context(options),
        agent,
        formatExplicit: agent,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))),
      );
      const backing = new MemoryStorage();
      const storage = cache
        ? backing
        : new Proxy(backing, {
            has: (target, key) => key !== 'getDiscoveryDocuments' && Reflect.has(target, key),
          });
      storage.setApiKey('key');
      const client = inflow();

      await expect(__testing.runInspect(commandContext({ timeout: 30 }), client)).resolves.toMatchObject({
        schema_version: 1,
      });
      await expect(
        __testing.runEnroll(commandContext({ interval: 1, maxAttempts: 1, timeout: 1 }), client, storage),
      ).resolves.toEqual({ status: 'active' });
      await expect(__testing.runStatus(commandContext(), client, storage)).resolves.toMatchObject({
        local: {
          available_grant_types: ['oauth-bearer'],
          grants: [],
        },
        service: { status: 'active' },
      });
      await expect(
        __testing.runGrant(commandContext({ interval: 1, scope: ['read', 'read'] }), client, storage),
      ).resolves.toEqual({
        credential_id: 'credential-1',
        expires_at: '2999-01-01T00:00:00.000Z',
        grant_type: 'oauth-bearer',
        granted: true,
        service_did: 'did:web:service.example',
        scopes: ['read'],
      });
      await expect(__testing.runStatus(commandContext(), client, storage)).resolves.toMatchObject({
        local: {
          grants: [
            {
              credential_id: 'credential-1',
              grant_type: 'oauth-bearer',
              scopes: ['read'],
              status: 'active',
              usable: true,
            },
          ],
        },
        service: { status: 'active' },
      });
      await expect(__testing.runRevoke(commandContext(), client, storage)).resolves.toEqual({
        all_grant_types: true,
        revoked: true,
      });
      await expect(__testing.runStatus(commandContext(), client, storage)).resolves.toMatchObject({
        local: { grants: [] },
        service: { status: 'active' },
      });
    },
  );

  it.each(['agent_identity_not_found', 'not_recognized', 'service_unavailable'])(
    'maps Status %s failures without confusing an unavailable Service with missing enrollment',
    async (code) => {
      const storage = new MemoryStorage();
      storage.setApiKey('key');
      const aepStorage = new AepStorage(storage, {
        platformOrigin: 'https://platform.example',
        userId: 'user-1',
      });
      await aepStorage.identities().saveIdentity(identity);
      platformRecovery.statusErrorCode = code;

      await expect(__testing.runStatus(context(), inflow(), storage)).rejects.toThrow(
        code === 'service_unavailable' ? code : 'AEP_NOT_ENROLLED',
      );
    },
  );

  it('reports AEP and unrelated authentication classifications for the exact resource', async () => {
    probeScenario.classification = 'aep-challenge';
    probeScenario.status = 401;
    await expect(__testing.runInspect(context({ timeout: 30 }), inflow())).resolves.toMatchObject({
      resource_authentication: { result: 'aep-authenticatable', status: 401 },
    });

    probeScenario.classification = 'unrelated-authentication';
    await expect(__testing.runInspect(context({ timeout: 30 }), inflow())).resolves.toMatchObject({
      resource_authentication: { result: 'other-authentication-required', status: 401 },
    });
  });

  it('maps local identity and invalid command inputs to stable errors', async () => {
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const client = inflow();

    await expect(
      __testing.runEnroll(context({ interval: 0, maxAttempts: 0, timeout: 900 }), client, storage),
    ).rejects.toThrow('AEP_INTERNAL_ERROR');
    await expect(__testing.runStatus(context(), client, storage)).resolves.toEqual({
      enrolled: false,
      local: { grants: [] },
      service: null,
    });
    await expect(
      __testing.runGrant(context({ grantType: 'not-advertised', scope: [] }), client, storage),
    ).rejects.toThrow('AEP_GRANT_TYPE_UNSUPPORTED');
    await expect(
      __testing.runRevoke(context({ credentialId: 'credential-1', grantType: 'oauth-bearer' }), client, storage),
    ).rejects.toThrow('AEP_INTERNAL_ERROR');
  });

  it('treats Grant as a graceful no-op when the Service advertises no grant types', async () => {
    const advertised = inspect.document.commands.grant_types ?? [];
    inspect.document.commands.grant_types = [];
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    try {
      await expect(__testing.runGrant(context({ scope: [] }), inflow(), storage)).resolves.toEqual({
        authentication: 'aep-jwt',
        grant_available: false,
        granted: false,
      });
    } finally {
      inspect.document.commands.grant_types = advertised;
    }
  });

  it('reports Grant as unavailable when the local identity is missing or unrecognized', async () => {
    const storage = new MemoryStorage();
    storage.setApiKey('key');

    await expect(__testing.runGrant(context({ scope: [] }), inflow(), storage)).resolves.toEqual({
      enrolled: false,
      granted: false,
      service_did: identity.serviceDid,
    });

    const persisted = new AepStorage(storage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await persisted.identities().saveIdentity(identity);
    platformRecovery.notRecognized = true;
    await expect(__testing.runGrant(context({ scope: [] }), inflow(), storage)).resolves.toEqual({
      enrolled: false,
      granted: false,
      service_did: identity.serviceDid,
    });
  });

  it.each([
    [{ credentialId: 'credential-1' }, { credential_id: 'credential-1', revoked: true }],
    [{ grantType: 'oauth-bearer' }, { grant_type: 'oauth-bearer', revoked: true }],
  ])('revokes the selected local credential set', async (options, expected) => {
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await persisted.identities().saveIdentity(identity);
    if ('credentialId' in options) {
      await persisted.credentials().saveCredential({
        credential: { credential_id: options.credentialId },
        credentialId: options.credentialId,
        expiresAt: '2999-01-01T00:00:00.000Z',
        grantType: 'oauth-bearer',
        issuedAt: '2026-01-01T00:00:00.000Z',
        serviceDid: identity.serviceDid,
      });
    }

    await expect(__testing.runRevoke(context(options), inflow(), storage)).resolves.toEqual(expected);
  });

  it('does not contact Revoke or sign when no local identity exists', async () => {
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const revoke = vi.spyOn(AepAgent, 'revokeService');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(__testing.runRevoke(context(), inflow(), storage)).rejects.toThrow('AEP_IDENTITY_NOT_FOUND');
    expect(revoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([new Error('Service unavailable'), 'Service unavailable', new AepAgent.AepCommandError('Failed', 500)])(
    'does not create an approval or credential when the enrollment status check fails: %s',
    async (failure) => {
      const storage = new MemoryStorage();
      storage.setApiKey('key');
      const persisted = new AepStorage(storage, {
        platformOrigin: 'https://platform.example',
        userId: 'user-1',
      });
      await persisted.identities().saveIdentity(identity);
      vi.spyOn(AepAgent, 'statusService').mockRejectedValueOnce(failure);
      const grant = vi.spyOn(AepAgent, 'grantService');

      await expect(__testing.runGrant(context({ scope: [] }), inflow(), storage)).rejects.toThrow();
      expect(platformRecovery.approvalsCreated).toBe(0);
      expect(grant).not.toHaveBeenCalled();
      expect(await persisted.credentials().findCredential(identity.serviceDid, 'credential-1')).toBeUndefined();
    },
  );

  it.each([true, false])(
    'returns Enroll guidance for unmet Grant requirements (agent=%s) without automatic retries',
    async (agent) => {
      platformRecovery.immediateSignResult = 'completed';
      const storage = new MemoryStorage();
      storage.setApiKey('key');
      const persisted = new AepStorage(storage, { platformOrigin: 'https://platform.example', userId: 'user-1' });
      await persisted.identities().saveIdentity(identity);
      const actual = await vi.importActual<typeof AepAgent>('@aep-foundation/agent');
      const problem = {
        code: 'requirements_unmet',
        status: 422,
        title: 'Requirements unmet',
        type: 'urn:aep:error:requirements_unmet',
        requirements_pending: ['contact.email', 'service_documents'],
        required_document_ids: ['terms'],
      };
      const transport = vi.fn(() => Promise.resolve(Response.json(problem, { status: 422 })));
      const grant = vi
        .spyOn(AepAgent, 'grantService')
        .mockImplementationOnce((options) => actual.grantService({ ...options, fetch: transport }));
      const enroll = vi.spyOn(AepAgent, 'enrollService');
      const error = vi.fn((value: unknown): never => {
        throw value;
      });
      await expect(
        __testing.runGrant({ ...context({ scope: [] }), agent, formatExplicit: agent, error }, inflow(), storage),
      ).rejects.toMatchObject({
        code: 'AEP_REQUIREMENTS_UNMET',
        cta: { commands: [{ command: 'aep enroll service.example', description: 'Review and update enrollment' }] },
        details: {
          requirements_pending: ['contact.email', 'service_documents'],
          required_document_ids: ['terms'],
          resolution: { action: 'enroll', tool: 'aep_enroll', input: { serviceReference: 'service.example' } },
        },
        message:
          'The Service requires updated enrollment information or document acceptance.' +
          '\n\nRequired information\n  contact.email\n  service_documents' +
          '\n\nRequired documents\n  terms' +
          '\n\nRun inflow aep enroll service.example to review and update enrollment. Then request Grant again when ready.',
        retryable: false,
      });
      expect(transport).toHaveBeenCalledOnce();
      expect(grant).toHaveBeenCalledOnce();
      expect(enroll).not.toHaveBeenCalled();
      expect(await persisted.credentials().listCredentials(identity.serviceDid)).toEqual([]);
    },
  );

  it('rejects per-credential Revoke when the credential is not stored locally', async () => {
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await persisted.identities().saveIdentity(identity);

    await expect(
      __testing.runRevoke(context({ credentialId: 'credential-missing' }), inflow(), storage),
    ).rejects.toThrow('AEP_CREDENTIAL_NOT_FOUND');
  });

  it.each([0, -1, 901])(
    'rejects an invalid enrollment timeout before inspecting or provisioning: %s',
    async (timeout) => {
      const storage = new MemoryStorage();
      storage.setApiKey('key');
      const client = inflow();
      const inspectCall = vi.spyOn(client.aep, 'inspect');
      await expect(__testing.runEnroll(context({ maxAttempts: 0, timeout }), client, storage)).rejects.toThrow(
        'AEP_INTERNAL_ERROR',
      );
      expect(inspectCall).not.toHaveBeenCalled();
      expect(storage.getAepState()).toBeNull();
      expect(platformRecovery.approvalsCreated).toBe(0);
    },
  );

  it.each([new Error('Status unavailable'), new AepCommandError('Unknown status failure', 500)])(
    'does not treat a failed Status request as permission to enroll: %s',
    async (failure) => {
      const storage = new MemoryStorage();
      storage.setApiKey('key');
      vi.spyOn(AepAgent, 'statusService').mockRejectedValueOnce(failure);
      const enroll = vi.spyOn(AepAgent, 'enrollService');
      await expect(__testing.runEnroll(context({ maxAttempts: 1, timeout: 1 }), inflow(), storage)).rejects.toThrow();
      expect(enroll).not.toHaveBeenCalled();
      expect(platformRecovery.approvalsCreated).toBe(0);
    },
  );

  it.each([true, false])('approves explicit repeated enrollment with the same identity (agent %s)', async (agent) => {
    const approvalFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 })),
    );
    vi.stubGlobal('fetch', approvalFetch);
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const client = inflow();
    const options = { ...context({ interval: 1, maxAttempts: 1, timeout: 1 }), agent, formatExplicit: agent };
    const enrolled = vi.spyOn(AepAgent, 'enrollService');

    await __testing.runEnroll(options, client, storage);
    const savedIdentity = storage.getAepState()?.identities[identity.serviceDid];
    await expect(__testing.runEnroll(options, client, storage)).resolves.toEqual({ status: 'active' });
    expect(approvalFetch).toHaveBeenCalledTimes(2);
    expect(platformRecovery.approvalsCreated).toBe(2);
    expect(enrolled).toHaveBeenCalledTimes(2);
    expect(storage.getAepState()?.identities[identity.serviceDid]).toEqual(savedIdentity);
    expect(enrolled.mock.calls[0]?.[0].agentDid).toBe(identity.agentDid);
    expect(enrolled.mock.calls[1]?.[0].agentDid).toBe(identity.agentDid);
    expect(enrolled.mock.calls[0]?.[0].idempotencyKey).not.toBe(enrolled.mock.calls[1]?.[0].idempotencyKey);
  });

  it('requests current claims on repeated enrollment and sends only approved claim values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status: 'APPROVED' }))),
    );
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const options = context({ interval: 1, maxAttempts: 1, timeout: 1 });
    const enrolled = vi.spyOn(AepAgent, 'enrollService');
    const grant = vi.spyOn(AepAgent, 'grantService');
    await __testing.runEnroll(options, inflow(), storage);

    const document = structuredClone(inspect.document);
    document.claims = { required: ['contact.email'], preferred: [], optional: ['person.first_name'] };
    await __testing.runEnroll(options, inflow({ ...inspect, document }), storage);

    expect(platformRecovery.signContexts.filter((value) => value['claims'] !== undefined)).toEqual([
      { claims: inspect.document.claims },
      { claims: document.claims },
    ]);
    expect(enrolled).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentDid: identity.agentDid, claims: { 'contact.email': 'agent@example.test' } }),
    );
    expect(grant).not.toHaveBeenCalled();
  });

  it.each([true, false])('hands approved documents to the real SDK (agent %s)', async (agent) => {
    const actual = await vi.importActual<typeof AepAgent>('@aep-foundation/agent');
    const enrolled = vi.spyOn(AepAgent, 'enrollService').mockImplementation(actual.enrollService);
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith('/aep/enroll')) {
          const body = JSON.parse(await new Response(init?.body).text()) as Record<string, unknown>;
          requests.push(body);
          return Promise.resolve(
            Response.json({
              status: 'active',
              acknowledged_document_ids: body['acknowledged_document_ids'],
              service_extension: 'retained',
            }),
          );
        }
        return Promise.resolve(Response.json({ status: 'APPROVED' }));
      }),
    );
    platformRecovery.approvedDocumentIds = ['privacy', 'terms'];
    const document = {
      ...inspect.document,
      extensions: { supported: ['urn:aep:ext:aep-foundation:service-documents#v=1.0.0'] },
      service_documents: [
        serviceDocument,
        { ...serviceDocument, id: 'privacy' },
        { ...serviceDocument, id: 'notice', enrollment: 'not-required' as const },
      ],
    };
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const options = {
      ...context({ interval: 1, maxAttempts: 1, timeout: 2 }),
      agent,
      formatExplicit: agent,
      error: (error: { code: string; message: string }): never => {
        throw new Error(`${error.code}: ${error.message}`);
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await __testing.runEnroll(options, inflow({ ...inspect, document }), storage)).toEqual({
        status: 'active',
        acknowledged_document_ids: ['privacy', 'terms'],
        service_extension: 'retained',
      });
    }
    expect(platformRecovery.signContexts.filter((value) => value['claims'] !== undefined)).toEqual([
      { claims: inspect.document.claims, required_document_ids: ['terms', 'privacy'] },
      { claims: inspect.document.claims, required_document_ids: ['terms', 'privacy'] },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      agent_did: identity.agentDid,
      acknowledged_document_ids: ['privacy', 'terms'],
    });
    expect(enrolled.mock.calls[1]?.[0].agentDid).toBe(identity.agentDid);
    if (!agent) {
      const pendingView = rendering.render.mock.calls.find(
        ([element]) => isValidElement(element) && element.type === PendingApprovalView,
      )?.[0];
      if (!isValidElement<{ children: ReactElement }>(pendingView)) throw new Error('Missing approval presentation');
      expect(pendingView.props.children.props).toMatchObject({
        documents: document.service_documents,
        serviceUrl: 'service.example',
      });
    } else expect(rendering.render).not.toHaveBeenCalled();
  });

  it('reports the real SDK error when the Service omits the acknowledgement echo', async () => {
    const actual = await vi.importActual<typeof AepAgent>('@aep-foundation/agent');
    vi.spyOn(AepAgent, 'enrollService').mockImplementation(actual.enrollService);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) =>
        Promise.resolve(Response.json({ status: String(url).endsWith('/aep/enroll') ? 'active' : 'APPROVED' })),
      ),
    );
    platformRecovery.approvedDocumentIds = ['terms'];
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const document = {
      ...inspect.document,
      extensions: { supported: ['urn:aep:ext:aep-foundation:service-documents#v=1.0.0'] },
      service_documents: [serviceDocument],
    };
    const error = vi.fn((failure: { code: string }) => {
      throw new Error(failure.code);
    });
    await expect(
      __testing.runEnroll(
        { ...context({ interval: 1, maxAttempts: 1, timeout: 2 }), error },
        inflow({ ...inspect, document }),
        storage,
      ),
    ).rejects.toThrow('AEP_ENROLL_RESPONSE_INVALID');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'AEP_ENROLL_RESPONSE_INVALID',
        message:
          'The Service did not confirm the approved document IDs in its enrollment response. ' +
          'The Service must return the same acknowledged_document_ids that were sent. Enrollment could not be confirmed.',
      }),
    );
  });

  it('resumes with the original approved IDs despite newly advertised required documents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status: 'APPROVED' }))),
    );
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const original = { ...inspect, document: { ...inspect.document, service_documents: [serviceDocument] } };
    const enrolled = vi.spyOn(AepAgent, 'enrollService');
    const pending = await __testing.runEnroll(context({ maxAttempts: 1, timeout: 2 }), inflow(original), storage);
    expect(pending['state']).toBe('pending');
    expect(enrolled).not.toHaveBeenCalled();
    expect(platformRecovery.signContexts.at(-1)).toMatchObject({ required_document_ids: ['terms'] });
    platformRecovery.approvedDocumentIds = ['terms'];
    await __testing.runEnroll(
      context({ approvalId: 'approval-1', maxAttempts: 1, timeout: 2 }),
      inflow({
        ...original,
        document: {
          ...original.document,
          service_documents: [serviceDocument, { ...serviceDocument, id: 'new-terms' }],
        },
      }),
      storage,
    );
    expect(enrolled).toHaveBeenCalledWith(expect.objectContaining({ acknowledgedDocumentIds: ['terms'] }));
    expect(platformRecovery.signContexts.at(-1)).toEqual({ approval_id: 'approval-1' });
    expect(platformRecovery.approvalsCreated).toBe(1);
  });

  it.each([
    undefined,
    null,
    'terms',
    ['terms', 'terms'],
    ['Terms'],
    [],
    ['terms', 'extra'],
    [1],
    ['bad id'],
    ['a'.repeat(33)],
    Array.from({ length: 8 }, (_, i) => `id${i}`),
  ])('does not submit enrollment with invalid or mismatched document approval: %j', async (approved) => {
    platformRecovery.approvedDocumentIds = approved;
    platformRecovery.immediateSignResult = 'completed';
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const enrolled = vi.spyOn(AepAgent, 'enrollService');
    await expect(
      __testing.runEnroll(
        context({ maxAttempts: 1, timeout: 2 }),
        inflow({
          ...inspect,
          document: { ...inspect.document, service_documents: [serviceDocument] },
        }),
        storage,
      ),
    ).rejects.toThrow('AEP_DOCUMENT_APPROVAL_INVALID');
    expect(enrolled).not.toHaveBeenCalled();
  });

  it.each([undefined, []])('preserves absent or explicitly empty approved IDs: %j', async (approved) => {
    platformRecovery.approvedDocumentIds = approved;
    platformRecovery.immediateSignResult = 'completed';
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const enrolled = vi.spyOn(AepAgent, 'enrollService');
    await __testing.runEnroll(
      context({ maxAttempts: 1, timeout: 2 }),
      inflow({
        ...inspect,
        document: { ...inspect.document, service_documents: [{ ...serviceDocument, enrollment: 'not-required' }] },
      }),
      storage,
    );
    expect(platformRecovery.signContexts.at(-1)).toEqual({ claims: inspect.document.claims });
    const input = enrolled.mock.calls[0]?.[0];
    if (approved === undefined) expect(input).not.toHaveProperty('acknowledgedDocumentIds');
    else expect(input).toHaveProperty('acknowledgedDocumentIds', []);
  });

  it('does not infer document acceptance for an older continued approval without document context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status: 'APPROVED' }))),
    );
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const enrolled = vi.spyOn(AepAgent, 'enrollService');
    await __testing.runEnroll(
      context({ approvalId: 'approval-1', maxAttempts: 1, timeout: 2 }),
      inflow({
        ...inspect,
        document: { ...inspect.document, service_documents: [serviceDocument] },
      }),
      storage,
    );
    expect(enrolled.mock.calls[0]?.[0]).not.toHaveProperty('acknowledgedDocumentIds');
    expect(platformRecovery.signContexts.at(-1)).toEqual({ approval_id: 'approval-1' });
  });

  it.each(['pending', 'rejected', 'suspended', 'terminated'] as const)(
    'preserves the Service decision %s for an explicit repeated enrollment',
    async (status) => {
      platformRecovery.identity = identity;
      platformRecovery.immediateSignResult = 'completed';
      vi.spyOn(AepAgent, 'statusService').mockResolvedValueOnce({
        body: { status },
        commandUrl: new URL('https://service.example/aep/status'),
        status: 200,
      });
      vi.spyOn(AepAgent, 'enrollService').mockResolvedValueOnce({
        body: { status },
        commandUrl: new URL('https://service.example/aep/enroll'),
        status: 200,
      });
      const storage = new MemoryStorage();
      storage.setApiKey('key');

      expect(await __testing.runEnroll(context({ maxAttempts: 1, timeout: 1 }), inflow(), storage)).toEqual({ status });
      expect(AepAgent.enrollService).toHaveBeenCalledOnce();
      expect(storage.getAepState()?.identities[identity.serviceDid]).toMatchObject(identity);
    },
  );

  it.each(['completed', 'completed-without-context', 'string'] as const)(
    'accepts an immediate %s Platform signature',
    async (resultKind) => {
      platformRecovery.immediateSignResult = resultKind;
      const storage = new MemoryStorage();
      storage.setApiKey('key');

      await expect(__testing.runEnroll(context({ maxAttempts: 1, timeout: 1 }), inflow(), storage)).resolves.toEqual({
        status: 'active',
      });
    },
  );

  it.each(['completed-without-context', 'string'] as const)(
    'completes human enrollment with a %s signature after approval',
    async (resultKind) => {
      const approval = vi.fn(() => {
        platformRecovery.immediateSignResult = resultKind;
        return Promise.resolve(Response.json({ status: 'APPROVED' }));
      });
      vi.stubGlobal('fetch', approval);
      const storage = new MemoryStorage();
      storage.setApiKey('key');
      const enrolled = vi.spyOn(AepAgent, 'enrollService');

      await __testing.runEnroll(
        { ...context({ maxAttempts: 1, timeout: 1 }), agent: false, formatExplicit: false },
        inflow(),
        storage,
      );

      expect(approval).toHaveBeenCalledOnce();
      expect(enrolled).toHaveBeenCalledOnce();
      expect(enrolled).toHaveBeenCalledWith(
        expect.objectContaining({
          clientAssertion: 'immediate-assertion',
          claims: {},
        }),
      );
      expect(platformRecovery.approvalsCreated).toBe(1);
    },
  );

  it('returns an agentic pending approval frame for a new enrollment without polling inline', async () => {
    const approvalFetch = vi.fn();
    vi.stubGlobal('fetch', approvalFetch);
    const storage = new MemoryStorage();
    storage.setApiKey('key');

    await expect(__testing.runEnroll(context({ maxAttempts: 0, timeout: 900 }), inflow(), storage)).resolves.toEqual({
      _next: {
        command: 'aep enroll service.example --approval-id approval-1 --interval 1 --max-attempts 0 --timeout 900',
        tool: 'aep_enroll',
        input: {
          serviceReference: 'service.example',
          approvalId: 'approval-1',
          interval: 1,
          maxAttempts: 0,
          timeout: 900,
        },
        poll_interval_seconds: 1,
        until: 'enrollment completes',
      },
      approval_id: 'approval-1',
      approval_url: 'https://platform.example/approvals/approval-1/view/',
      instruction:
        'Present the approval_url to the user and ask them to approve in the InFlow mobile app or dashboard. Then call AEP enroll again with the approval id.',
      service_did: 'did:web:service.example',
      state: 'pending',
      retry_after_seconds: 1,
    });
    expect(approvalFetch).not.toHaveBeenCalled();
  });

  it('continues an agentic enrollment approval and returns the Service response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))),
    );
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await persisted.identities().saveIdentity(identity);

    const pending = await __testing.runEnroll(context({ maxAttempts: 1, timeout: 1 }), inflow(), storage);
    const next = pending['_next'] as { tool: string; input: Record<string, unknown> };
    expect(next.tool).toBe('aep_enroll');
    await expect(
      __testing.runEnroll(
        {
          ...context(enrollOptions.parse(next.input)),
          args: serviceReferenceArgs.parse(next.input),
        },
        inflow(),
        storage,
      ),
    ).resolves.toEqual({ status: 'active' });
    expect(platformRecovery.approvalsCreated).toBe(1);
  });

  it('returns an agentic pending approval frame for Grant without polling inline', async () => {
    const approvalFetch = vi.fn();
    vi.stubGlobal('fetch', approvalFetch);
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await persisted.identities().saveIdentity(identity);

    await expect(__testing.runGrant(context({ scope: ['read'], timeout: 900 }), inflow(), storage)).resolves.toEqual({
      _next: {
        command:
          'aep grant service.example --approval-id approval-1 --grant-type oauth-bearer --interval 1 --timeout 900 --scope read',
        tool: 'aep_grant',
        input: {
          serviceReference: 'service.example',
          approvalId: 'approval-1',
          grantType: 'oauth-bearer',
          scope: ['read'],
          interval: 1,
          timeout: 900,
        },
        poll_interval_seconds: 1,
        until: 'credential grant completes',
      },
      approval_id: 'approval-1',
      approval_url: 'https://platform.example/approvals/approval-1/view/',
      grant_type: 'oauth-bearer',
      instruction:
        'Present the approval_url to the user and ask them to approve in the InFlow mobile app or dashboard. Then call AEP grant again with the approval id.',
      service_did: 'did:web:service.example',
      state: 'pending',
      retry_after_seconds: 1,
    });
    expect(approvalFetch).not.toHaveBeenCalled();
  });

  it('continues an agentic Grant approval and stores the issued credential', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))),
    );
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await persisted.identities().saveIdentity(identity);

    const pending = await __testing.runGrant(context({ scope: ['read', 'read'], timeout: 1 }), inflow(), storage);
    const next = pending['_next'] as { tool: string; input: Record<string, unknown> };
    expect(next.tool).toBe('aep_grant');
    expect(next.input['scope']).toEqual(['read']);
    await expect(
      __testing.runGrant(
        {
          ...context(grantOptions.parse(next.input)),
          args: serviceReferenceArgs.parse(next.input),
        },
        inflow(),
        storage,
      ),
    ).resolves.toEqual({
      credential_id: 'credential-1',
      expires_at: '2999-01-01T00:00:00.000Z',
      grant_type: 'oauth-bearer',
      granted: true,
      service_did: 'did:web:service.example',
      scopes: ['read'],
    });
    expect(platformRecovery.approvalsCreated).toBe(1);
  });

  it('rehydrates a missing local identity from the Platform before checking Status', async () => {
    platformRecovery.identity = identity;
    const approvalFetch = vi.fn(() => Promise.resolve(Response.json({ status: 'APPROVED' })));
    vi.stubGlobal('fetch', approvalFetch);
    const storage = new MemoryStorage();
    storage.setApiKey('key');

    await expect(
      __testing.runEnroll(context({ interval: 1, maxAttempts: 1, timeout: 1 }), inflow(), storage),
    ).resolves.toEqual({ status: 'active' });
    expect(approvalFetch).toHaveBeenCalledOnce();
    expect(storage.getAepState()?.identities[identity.serviceDid]).toMatchObject(identity);
  });

  it('enrolls a recovered Platform identity when the Service does not recognize it', async () => {
    platformRecovery.identity = identity;
    platformRecovery.notRecognized = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))),
    );
    const storage = new MemoryStorage();
    storage.setApiKey('key');

    await expect(
      __testing.runEnroll(context({ interval: 1, maxAttempts: 1, timeout: 1 }), inflow(), storage),
    ).resolves.toEqual({ status: 'active' });
  });

  it('replaces a stale local identity when Platform Sign cannot find it', async () => {
    platformRecovery.identityNotFoundOnSign = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))),
    );
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await persisted.identities().saveIdentity({ ...identity, agentDid: 'did:web:platform.example:agents:deleted' });

    await expect(
      __testing.runEnroll(context({ interval: 1, maxAttempts: 1, timeout: 1 }), inflow(), storage),
    ).resolves.toEqual({ status: 'active' });
    expect(storage.getAepState()?.identities[identity.serviceDid]?.agentDid).toBe(identity.agentDid);
  });

  it('maps a declined approval to the AEP approval-denied error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'DECLINED' }), { status: 200 }))),
    );
    const storage = new MemoryStorage();
    storage.setApiKey('key');

    await expect(
      __testing.runEnroll(context({ interval: 1, maxAttempts: 1, timeout: 1 }), inflow(), storage),
    ).rejects.toThrow('AEP_APPROVAL_DENIED');
  });

  it('reports a missing Inspect endpoint as a Service that does not advertise AEP', async () => {
    const client = inflow();
    const { AepInspectError } = await import('@aep-foundation/agent');
    client.aep.inspect = () => {
      throw new AepInspectError('Not found', 'http_error', 404);
    };

    await expect(__testing.runInspect(context({ timeout: 30 }), client)).resolves.toEqual({
      outcome: 'not-advertised',
      schema_version: 1,
      service_url: 'https://service.example/',
      status: 404,
    });
  });
});
