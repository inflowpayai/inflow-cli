import { afterEach, describe, expect, it, vi } from 'vitest';
import { AepFetchError, AepStorage, MemoryStorage, SecureStorageError } from '@inflowpayai/inflow-core';
import {
  AepClaimRequirementsError,
  AepClaimValuesError,
  AepCommandError,
  AepInspectError,
  AepServiceReferenceError,
} from '@aep-foundation/agent';
import type { InspectServiceResult } from '@aep-foundation/agent';
import type * as InflowCore from '@inflowpayai/inflow-core';

const platformRecovery = vi.hoisted<{
  identity: unknown;
  identityNotFoundOnSign: boolean;
  immediateSignResult: 'completed' | 'string' | undefined;
  notRecognized: boolean;
  provisioned: boolean;
  statusErrorCode: string | undefined;
}>(() => ({
  identity: undefined,
  identityNotFoundOnSign: false,
  immediateSignResult: undefined,
  notRecognized: false,
  provisioned: false,
  statusErrorCode: undefined,
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

vi.mock('@aep-foundation/agent', () => {
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
  class AepCommandError extends Error {
    problem?: { code: string };

    constructor(message?: string, _status?: number, problem?: { code: string }) {
      super(message);
      if (problem !== undefined) this.problem = problem;
    }
  }
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
    if (platformRecovery.identityNotFoundOnSign) {
      platformRecovery.identityNotFoundOnSign = false;
      const error = new AepCommandError();
      error.problem = { code: 'agent_identity_not_found' };
      throw error;
    }
    if (platformRecovery.immediateSignResult === 'string') return 'immediate-assertion';
    if (platformRecovery.immediateSignResult === 'completed') {
      return {
        clientAssertion: 'immediate-assertion',
        platformContext: { approved_claims: { 'contact.email': 'agent@example.test' } },
        status: 'completed' as const,
      };
    }
    if (context.platformContext?.['claims'] !== undefined || context.platformContext?.['grant_type'] !== undefined) {
      return { platformContext: { approval_id: 'approval-1' }, retryAfterSeconds: 1, status: 'pending' as const };
    }
    return {
      clientAssertion: 'assertion',
      platformContext: { approved_claims: { 'contact.email': 'agent@example.test' } },
      status: 'completed' as const,
    };
  };
  return {
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
        const error = new AepCommandError();
        error.problem = { code: platformRecovery.statusErrorCode ?? 'not_recognized' };
        throw error;
      }
      return { body: { status: 'active' } };
    },
  };
});

const { __testing, createAepCli } = await import('../../../../src/commands/aep/index.js');

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

function inflow() {
  return {
    aep: { inspect: () => inspect },
    hasApiKey: () => false,
    platformAuthenticationHeaders: () => ({ 'X-API-KEY': 'key' }),
    resolvedApiBaseUrl: 'https://platform.example',
    user: { retrieve: () => ({ userId: 'user-1' }) },
  } as never;
}

afterEach(() => {
  platformRecovery.identity = undefined;
  platformRecovery.identityNotFoundOnSign = false;
  platformRecovery.immediateSignResult = undefined;
  platformRecovery.notRecognized = false;
  platformRecovery.provisioned = false;
  platformRecovery.statusErrorCode = undefined;
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
    for (const command of ['inspect', 'enroll', 'fetch', 'status', 'grant', 'revoke']) {
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
    expect(__testing.commandError(new AepInspectError('failed', 'response_too_large'))).toEqual({
      code: 'AEP_INSPECT_RESPONSE_TOO_LARGE',
      message: 'AEP Service Inspect failed.',
      retryable: true,
    });
    const identityMismatch = new AepInspectError('failed');
    Object.defineProperty(identityMismatch, 'code', { value: 'service_identity_mismatch' });
    expect(__testing.commandError(identityMismatch)).toEqual({
      code: 'AEP_SERVICE_IDENTITY_MISMATCH',
      message: 'AEP Service Inspect failed.',
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
      message: 'The Platform cannot satisfy the required Service claims.',
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
    __testing.closePendingApprovalView(undefined);
    __testing.closePendingApprovalView({ clear, unmount });
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

  it('maps core fetch failures to their typed CLI code', async () => {
    fetchScenario.run = () => Promise.reject(new AepFetchError('AEP_RESPONSE_TOO_LARGE', 'too large'));
    await expect(
      __testing.runFetch(
        {
          ...context({ header: [], maxRedirects: 5, maxResponseBytes: 1, method: 'GET', showBody: true, timeout: 30 }),
          args: { resourceUrl: 'https://service.example/resource' },
        },
        inflow(),
        new MemoryStorage(),
      ),
    ).rejects.toThrow('AEP_RESPONSE_TOO_LARGE');
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

  it('runs inspect, enrollment, status, grant, and revoke without exposing credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))),
    );
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const client = inflow();

    await expect(__testing.runInspect(context({ timeout: 30 }), client)).resolves.toMatchObject({ schema_version: 1 });
    await expect(
      __testing.runEnroll(context({ interval: 1, maxAttempts: 1, timeout: 1 }), client, storage),
    ).resolves.toEqual({ status: 'active' });
    await expect(__testing.runStatus(context(), client, storage)).resolves.toMatchObject({
      local: {
        available_grant_types: ['oauth-bearer'],
        grants: [],
      },
      service: { status: 'active' },
    });
    await expect(
      __testing.runGrant(context({ interval: 1, scope: ['read', 'read'] }), client, storage),
    ).resolves.toEqual({
      credential_id: 'credential-1',
      expires_at: '2999-01-01T00:00:00.000Z',
      grant_type: 'oauth-bearer',
      granted: true,
      service_did: 'did:web:service.example',
      scopes: ['read'],
    });
    await expect(__testing.runStatus(context(), client, storage)).resolves.toMatchObject({
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
    await expect(__testing.runRevoke(context(), client, storage)).resolves.toEqual({
      all_grant_types: true,
      revoked: true,
    });
    await expect(__testing.runStatus(context(), client, storage)).resolves.toMatchObject({
      local: { grants: [] },
      service: { status: 'active' },
    });
  });

  it.each(['agent_identity_not_found', 'not_recognized'])(
    'maps Status %s failures to an actionable not-enrolled error',
    async (code) => {
      const storage = new MemoryStorage();
      storage.setApiKey('key');
      const aepStorage = new AepStorage(storage, {
        platformOrigin: 'https://platform.example',
        userId: 'user-1',
      });
      await aepStorage.identities().saveIdentity(identity);
      platformRecovery.statusErrorCode = code;

      await expect(__testing.runStatus(context(), inflow(), storage)).rejects.toThrow('AEP_NOT_ENROLLED');
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

    await expect(__testing.runRevoke(context(options), inflow(), storage)).resolves.toEqual(expected);
  });

  it('checks Status and skips approval when enrolling an existing identity', async () => {
    const approvalFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 })),
    );
    vi.stubGlobal('fetch', approvalFetch);
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const client = inflow();
    const options = context({ interval: 1, maxAttempts: 1, timeout: 1 });

    await __testing.runEnroll(options, client, storage);
    const approvalRequests = approvalFetch.mock.calls.length;
    await expect(__testing.runEnroll(options, client, storage)).resolves.toEqual({ status: 'active' });
    expect(approvalFetch).toHaveBeenCalledTimes(approvalRequests);
  });

  it.each(['completed', 'string'] as const)('accepts an immediate %s Platform signature', async (resultKind) => {
    platformRecovery.immediateSignResult = resultKind;
    const storage = new MemoryStorage();
    storage.setApiKey('key');

    await expect(__testing.runEnroll(context({ maxAttempts: 1, timeout: 1 }), inflow(), storage)).resolves.toEqual({
      status: 'active',
    });
  });

  it('returns an agentic pending approval frame for a new enrollment without polling inline', async () => {
    const approvalFetch = vi.fn();
    vi.stubGlobal('fetch', approvalFetch);
    const storage = new MemoryStorage();
    storage.setApiKey('key');

    await expect(__testing.runEnroll(context({ maxAttempts: 0, timeout: 900 }), inflow(), storage)).resolves.toEqual({
      _next: {
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
    platformRecovery.notRecognized = true;
    const storage = new MemoryStorage();
    storage.setApiKey('key');
    const persisted = new AepStorage(storage, {
      platformOrigin: 'https://platform.example',
      userId: 'user-1',
    });
    await persisted.identities().saveIdentity(identity);

    await expect(
      __testing.runEnroll(
        context({ approvalId: 'approval-1', interval: 1, maxAttempts: 1, timeout: 1 }),
        inflow(),
        storage,
      ),
    ).resolves.toEqual({ status: 'active' });
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

    await expect(
      __testing.runGrant(
        context({
          approvalId: 'approval-1',
          grantType: 'oauth-bearer',
          interval: 1,
          scope: ['read'],
          timeout: 1,
        }),
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
  });

  it('rehydrates a missing local identity from the Platform before checking Status', async () => {
    platformRecovery.identity = identity;
    const approvalFetch = vi.fn();
    vi.stubGlobal('fetch', approvalFetch);
    const storage = new MemoryStorage();
    storage.setApiKey('key');

    await expect(
      __testing.runEnroll(context({ interval: 1, maxAttempts: 1, timeout: 1 }), inflow(), storage),
    ).resolves.toEqual({ status: 'active' });
    expect(approvalFetch).not.toHaveBeenCalled();
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
    const client = inflow() as { aep: { inspect: () => never } };
    const { AepInspectError } = await import('@aep-foundation/agent');
    client.aep.inspect = () => {
      throw new AepInspectError('Not found', 'http_error', 404);
    };

    await expect(__testing.runInspect(context({ timeout: 30 }), client as never)).resolves.toEqual({
      outcome: 'not-advertised',
      schema_version: 1,
      service_url: 'https://service.example/',
      status: 404,
    });
  });
});
