import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ServiceDocumentsTable } from '../../../../src/commands/aep/documents.js';
import {
  EnrollView,
  FetchView,
  GrantUnavailableView,
  GrantView,
  InspectNotAdvertisedView,
  InspectView,
  AepDetailsTable,
  NotEnrolledView,
  PendingApprovalView,
  RevokeView,
  StatusView,
} from '../../../../src/commands/aep/views.js';

describe('AEP views', () => {
  it('includes documents in the shared standalone and combined AEP details view', () => {
    const view = render(
      <AepDetailsTable
        serviceUrl="https://service.example"
        document={{
          service: { did: 'did:web:service.example' },
          commands: { supported: ['inspect'] },
          service_documents: [
            {
              id: 'terms',
              title: 'Terms',
              type: 'terms_of_service',
              enrollment: 'required',
              representations: [{ media_type: 'text/html', url: 'https://service.example/terms' }],
            },
          ],
        }}
      />,
    );
    const output = view.lastFrame() ?? '';
    expect(output).toContain('Service documents');
    expect(output).toContain('terms');
    expect(output.indexOf('Document ID')).toBeLessThan(output.indexOf('Title'));
    view.unmount();
  });
  it.each(['active', 'rejected'])('renders %s enrollment without a misleading follow-up', (status) => {
    const view = render(
      <EnrollView onComplete={() => undefined} serviceDid="did:web:service.example" status={status} />,
    );
    expect(view.lastFrame()).toContain(`Enrollment ${status}`);
    expect((view.lastFrame() ?? '').includes('Use `inflow aep status`')).toBe(status !== 'active');
    view.unmount();
  });

  it('shows advertised claims and credential expiration without inventing missing scopes', () => {
    const inspected = render(
      <InspectView
        document={{
          commands: { supported: ['enroll'] },
          service: { did: 'did:web:service.example' },
          claims: { required: ['contact.email'], preferred: ['person.first_name'], optional: ['person.last_name'] },
        }}
        serviceUrl="https://service.example"
        onComplete={() => undefined}
      />,
    );
    for (const claim of ['contact.email', 'person.first_name', 'person.last_name'])
      expect(inspected.lastFrame()).toContain(claim);
    inspected.unmount();
    const status = render(
      <StatusView
        availableGrantTypes={['api-key']}
        service={{ status: 'active' }}
        serviceDid="did:web:service.example"
        onComplete={() => undefined}
        grants={[
          {
            credential_id: 'key-1',
            grant_type: 'api-key',
            status: 'active',
            scopes: undefined,
            expires_at: '2030-01-01T00:00:00Z',
          },
        ]}
      />,
    );
    expect(status.lastFrame()).toContain('2030-01-01T00:00:00Z');
    expect(status.lastFrame()).toMatch(/key-1\s+active\s+None/);
    status.unmount();
    const grant = render(
      <GrantView
        credentialId="key-1"
        grantType="api-key"
        scopes={[]}
        serviceDid="did:web:service.example"
        expiresAt="2030-01-01T00:00:00Z"
        onComplete={() => undefined}
      />,
    );
    expect(grant.lastFrame()).toContain('Expires: 2030-01-01T00:00:00Z');
    expect(grant.lastFrame()).toContain('Scopes: None');
    grant.unmount();
  });

  it('renders the resource fetch summary', () => {
    const view = render(
      <FetchView
        authentication="aep-jwt"
        body='{"widgets":[1,2,3]}'
        contentType="text/plain"
        finalUrl="https://service.example/final"
        onComplete={() => undefined}
        responseSizeBytes={12}
        status={200}
      />,
    );
    expect(view.lastFrame()).toContain('HTTP 200');
    expect(view.lastFrame()).toContain('aep-jwt');
    expect(view.lastFrame()).toContain('{"widgets":[1,2,3]}');
  });

  it('renders a payment-required AEP fetch result', () => {
    const view = render(
      <FetchView
        authentication="aep-jwt"
        contentType="application/json"
        finalUrl="https://service.example/final"
        onComplete={() => undefined}
        paymentRequired={{
          commands: ['mpp pay https://service.example/final', 'x402 pay https://service.example/final'],
          protocols: ['mpp', 'x402'],
        }}
        responseSizeBytes={42}
        status={402}
      />,
    );
    expect(view.lastFrame()).toContain('HTTP 402');
    expect(view.lastFrame()).toContain('Payment required: mpp, x402');
    expect(view.lastFrame()).toContain('Run: mpp pay https://service.example/final');
    expect(view.lastFrame()).toContain('Run: x402 pay https://service.example/final');
  });

  it('presents pending approval instructions', () => {
    const view = render(
      <PendingApprovalView
        approvalId="approval-1"
        approvalUrl="https://app.example/approvals/approval-1/view/"
        onCancel={() => undefined}
      />,
    );
    expect(view.lastFrame()).toContain('Approval required');
    expect(view.lastFrame()).toContain('approval-1');
    expect(view.lastFrame()).toContain('Waiting for approval');
    view.unmount();
  });

  it('shows document IDs and links beside the human approval without another acceptance prompt', () => {
    const view = render(
      <PendingApprovalView
        approvalId="approval-1"
        approvalUrl="https://app.example/approval"
        onCancel={() => undefined}
      >
        <ServiceDocumentsTable
          serviceUrl="https://service.example"
          documents={[
            {
              id: 'terms',
              title: 'Terms',
              type: 'terms_of_service',
              enrollment: 'required',
              representations: [{ media_type: 'text/html', url: 'https://service.example/terms' }],
            },
          ]}
        />
      </PendingApprovalView>,
    );
    const output = view.lastFrame() ?? '';
    for (const text of [
      'Document ID',
      'terms',
      'Required',
      'https://service.example/terms',
      'https://app.example/approval',
    ])
      expect(output).toContain(text);
    expect(output).not.toContain('Press Enter to accept');
    view.unmount();
  });

  it.each([
    ['Escape', '\u001b'],
    ['Ctrl-C', '\u0003'],
  ])('cancels a pending approval on %s', async (_label, input) => {
    const onCancel = vi.fn();
    const view = render(
      <PendingApprovalView
        approvalId="approval-1"
        approvalUrl="https://app.example/approvals/approval-1/view/"
        onCancel={onCancel}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    view.stdin.write(input);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(view.lastFrame()).toContain('Cancelling approval');
    view.unmount();
  });

  it('continues waiting and permits a retry when cancellation fails', async () => {
    const onCancel = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    const view = render(
      <PendingApprovalView
        approvalId="approval-1"
        approvalUrl="https://app.example/approvals/approval-1/view/"
        onCancel={onCancel}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    view.stdin.write('\u001b');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(view.lastFrame()).toContain('Unable to cancel approval');
    view.stdin.write('\u001b');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onCancel).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('presents a missing enrollment as a normal status', () => {
    const view = render(<NotEnrolledView onComplete={() => undefined} serviceDid="did:web:service.example" />);
    expect(view.lastFrame()).toContain('Not enrolled with this Service.');
    expect(view.lastFrame()).toContain('did:web:service.example');
    view.unmount();
  });

  it('explains JWT authentication when no session credentials are stored', () => {
    const view = render(
      <StatusView
        availableGrantTypes={['oauth-bearer']}
        grants={[]}
        onComplete={() => undefined}
        service={{ status: 'active' }}
        serviceDid="did:web:service.example"
      />,
    );
    expect(view.lastFrame()).toContain('Authentication');
    expect(view.lastFrame()).toContain('AEP JWT');
    expect(view.lastFrame()).toContain('None');
    expect(view.lastFrame()).toContain('oauth-bearer');
    expect(view.lastFrame()).not.toContain('Stored Session Credentials');
    expect(view.lastFrame()).not.toContain('Credential ID');
    expect(view.lastFrame()).not.toContain('Enrollment');
    expect(view.lastFrame()).not.toContain('Local grants');
    view.unmount();
  });

  it('explains when a Service does not advertise AEP', () => {
    const view = render(
      <InspectNotAdvertisedView onComplete={() => undefined} serviceUrl="https://service.example/" />,
    );
    expect(view.lastFrame()).toContain('No AEP discovery document was found (HTTP 404).');
    expect(view.lastFrame()).toContain('https://service.example/.well-known/aep');
    view.unmount();
  });

  it('renders concise non-secret command summaries', () => {
    const complete = vi.fn();
    const inspected = render(
      <InspectView
        document={{
          commands: { grant_types: ['oauth-bearer'], supported: ['inspect', 'grant'] },
          service: { did: 'did:web:service.example' },
        }}
        onComplete={complete}
        serviceUrl="https://service.example"
      />,
    );
    expect(inspected.lastFrame()).toContain('AEP Service');
    expect(inspected.lastFrame()).toContain('CLI commands');
    expect(inspected.lastFrame()).toContain('enroll, fetch, grant, inspect, revoke, status');
    expect(inspected.lastFrame()).not.toContain('inspect, grant');
    expect(inspected.lastFrame()).toContain('oauth-bearer');
    inspected.unmount();

    const enrolled = render(<EnrollView onComplete={complete} serviceDid="did:web:service.example" status="pending" />);
    expect(enrolled.lastFrame()).toContain('Enrollment pending');
    enrolled.unmount();
    const status = render(
      <StatusView
        availableGrantTypes={['oauth-bearer']}
        grants={[{ credential_id: 'credential-1', grant_type: 'oauth-bearer', scopes: ['read'], status: 'active' }]}
        onComplete={complete}
        service={{ owner_action_required: 'true', status: 'active' }}
        serviceDid="did:web:service.example"
      />,
    );
    expect(status.lastFrame()).toContain('Authentication');
    expect(status.lastFrame()).toContain('Available credential types');
    expect(status.lastFrame()).toContain('oauth-bearer');
    expect(status.lastFrame()).toContain('Stored Session Credentials');
    expect(status.lastFrame()).toMatch(/\n\nStored Session Credentials/);
    expect(status.lastFrame()).toContain('Grant Type');
    expect(status.lastFrame()).toContain('Credential ID');
    expect(status.lastFrame()).toContain('Status');
    expect(status.lastFrame()).toContain('Scopes');
    expect(status.lastFrame()).toContain('Expires');
    expect(status.lastFrame()).toContain('credential-1');
    expect(status.lastFrame()).toContain('active');
    expect(status.lastFrame()).not.toContain('Enrollment');
    status.unmount();
    const granted = render(
      <GrantView
        credentialId="credential-1"
        grantType="oauth-bearer"
        onComplete={complete}
        scopes={['read']}
        serviceDid="did:web:service.example"
      />,
    );
    expect(granted.lastFrame()).toContain('Credential issued and stored');
    expect(granted.lastFrame()).toContain('credential-1');
    expect(granted.lastFrame()).toContain('did:web:service.example');
    granted.unmount();
    const unavailable = render(<GrantUnavailableView onComplete={complete} />);
    expect(unavailable.lastFrame()).toContain('No session credential is required.');
    expect(unavailable.lastFrame()).toContain('AEP JWT authentication');
    unavailable.unmount();
    const revoked = render(<RevokeView onComplete={complete} selector="all grant types" />);
    expect(revoked.lastFrame()).toContain('Revoked all grant types');
    revoked.unmount();
  });

  it('renders the matched resource and authentication in the Service details', () => {
    const inspected = render(
      <InspectView
        document={{
          commands: { grant_types: ['oauth-bearer'], supported: ['inspect', 'grant'] },
          service: { did: 'did:web:service.example' },
        }}
        onComplete={() => undefined}
        openApiPolicy={{
          freshness: 'fresh',
          matchedOperation: { method: 'GET', pathTemplate: '/api/{id}' },
          methods: ['oauth-bearer'],
          state: 'required',
          strictSlashSuggestion: '/api/123',
        }}
        resourceAuthentication="AEP authenticatable"
        serviceUrl="https://service.example"
      />,
    );

    expect(inspected.lastFrame()).toContain('Resource path');
    expect(inspected.lastFrame()).toContain('/api/{id}');
    expect(inspected.lastFrame()).toContain('Similar resource');
    expect(inspected.lastFrame()).toContain('oauth-bearer');
    expect(inspected.lastFrame()).not.toContain('Policy state');
    inspected.unmount();
  });
});
