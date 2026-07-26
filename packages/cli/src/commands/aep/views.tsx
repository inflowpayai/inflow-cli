import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useState } from 'react';
import { openUrl } from '../../utils/open-url.js';
import { Table, type TableColumn } from '../../utils/table.js';

interface AepOpenApiOperationPolicyView {
  matchedOperation?: { method: string; pathTemplate: string };
  state: 'public' | 'required' | 'fallback';
  methods: readonly string[];
  freshness: 'fresh' | 'revalidated' | 'fetched';
  strictSlashSuggestion?: string;
}

interface ViewProps {
  onComplete: () => void;
}

function useComplete(onComplete: () => void): void {
  const { exit } = useApp();
  useEffect(() => {
    onComplete();
    exit();
  }, [exit, onComplete]);
}

interface InspectViewProps extends ViewProps {
  document: {
    claims?: { optional?: string[]; preferred?: string[]; required?: string[] };
    commands: { grant_types?: string[]; supported: string[] };
    identity?: { methods?: string[] };
    service: { did: string };
  };
  serviceUrl: string;
  openApiPolicy?: AepOpenApiOperationPolicyView;
  resourceAuthentication?: string;
}

interface DetailRow {
  field: string;
  value: string;
}

const DETAIL_COLUMNS: ReadonlyArray<TableColumn<DetailRow>> = [
  { header: 'Field', cell: (row) => row.field },
  { header: 'Value', cell: (row) => row.value },
];

function listed(values: readonly string[] | undefined): string {
  return values === undefined || values.length === 0 ? 'None' : values.join(', ');
}

const CLI_COMMANDS = ['enroll', 'fetch', 'grant', 'inspect', 'revoke', 'status'] as const;

export const AepDetailsTable: React.FC<
  Pick<InspectViewProps, 'document' | 'openApiPolicy' | 'resourceAuthentication' | 'serviceUrl'>
> = ({ document, openApiPolicy, resourceAuthentication, serviceUrl }) => {
  const operation = openApiPolicy?.matchedOperation;
  const rows: DetailRow[] = [
    { field: 'Service URL', value: serviceUrl },
    { field: 'Service DID', value: document.service.did },
    ...(operation === undefined ? [] : [{ field: 'Resource path', value: operation.pathTemplate }]),
    ...(openApiPolicy?.strictSlashSuggestion === undefined
      ? []
      : [{ field: 'Similar resource', value: openApiPolicy.strictSlashSuggestion }]),
    { field: 'Resource authentication', value: resourceAuthentication ?? 'Not checked' },
    { field: 'CLI commands', value: listed(CLI_COMMANDS) },
    { field: 'Identity methods', value: listed(document.identity?.methods) },
    {
      field: 'Authentication',
      value: listed(openApiPolicy?.methods) === 'None' ? 'AEP JWT' : listed(openApiPolicy?.methods),
    },
    { field: 'Session credential types', value: listed(document.commands.grant_types) },
    { field: 'Required claims', value: listed(document.claims?.required) },
    { field: 'Preferred claims', value: listed(document.claims?.preferred) },
    { field: 'Optional claims', value: listed(document.claims?.optional) },
  ];
  return <Table columns={DETAIL_COLUMNS} rows={rows} />;
};

export const InspectView: React.FC<InspectViewProps> = ({
  document,
  onComplete,
  openApiPolicy,
  resourceAuthentication,
  serviceUrl,
}) => {
  useComplete(() => onComplete());
  return (
    <Box flexDirection="column">
      <Text bold>AEP Service</Text>
      <AepDetailsTable
        document={document}
        {...(openApiPolicy === undefined ? {} : { openApiPolicy })}
        {...(resourceAuthentication === undefined ? {} : { resourceAuthentication })}
        serviceUrl={serviceUrl}
      />
    </Box>
  );
};

interface InspectNotAdvertisedViewProps extends ViewProps {
  serviceUrl: string;
}

export const InspectNotAdvertisedView: React.FC<InspectNotAdvertisedViewProps> = ({ onComplete, serviceUrl }) => {
  useComplete(() => onComplete());
  return (
    <Box flexDirection="column">
      <Text>This Service does not advertise AEP.</Text>
      <Text dimColor>{serviceUrl}</Text>
    </Box>
  );
};

interface EnrollViewProps extends ViewProps {
  serviceDid: string;
  status: string;
}

export const EnrollView: React.FC<EnrollViewProps> = ({ onComplete, serviceDid, status }) => {
  useComplete(() => onComplete());
  return (
    <Box flexDirection="column">
      <Text color={status === 'rejected' ? 'red' : status === 'active' ? 'green' : 'yellow'}>Enrollment {status}</Text>
      <Text dimColor>{serviceDid}</Text>
      {status !== 'active' && <Text dimColor>Use `inflow aep status` for lifecycle details.</Text>}
    </Box>
  );
};

interface PendingApprovalViewProps {
  approvalId: string;
  approvalUrl: string;
  onCancel: () => Promise<void> | void;
}

export const PendingApprovalView: React.FC<PendingApprovalViewProps> = ({ approvalId, approvalUrl, onCancel }) => {
  const [cancelling, setCancelling] = useState(false);
  useInput((input, key) => {
    if (key.return) openUrl(approvalUrl);
    if (key.escape || (key.ctrl && input === 'c')) {
      setCancelling(true);
      void onCancel();
    }
  });
  if (cancelling) {
    return (
      <Text color="yellow">
        <Spinner type="dots" /> Cancelling approval...
      </Text>
    );
  }
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>Approval required</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text>{`approval: ${approvalId}`}</Text>
        <Text>
          {'Open: '}
          <Text bold color="cyan">
            {approvalUrl}
          </Text>
        </Text>
        <Text dimColor>Press Enter to open in browser.</Text>
        <Text dimColor>Press Escape or Ctrl-C to cancel.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="cyan">
          <Spinner type="dots" /> Waiting for approval...
        </Text>
      </Box>
    </Box>
  );
};

interface GrantViewProps extends ViewProps {
  credentialId: string;
  expiresAt?: string;
  grantType: string;
  scopes: string[];
  serviceDid: string;
}

export const GrantView: React.FC<GrantViewProps> = ({
  credentialId,
  expiresAt,
  grantType,
  onComplete,
  scopes,
  serviceDid,
}) => {
  useComplete(() => onComplete());
  return (
    <Box flexDirection="column">
      <Text color="green">Credential issued and stored</Text>
      <Text>Service DID: {serviceDid}</Text>
      <Text>Grant type: {grantType}</Text>
      <Text>Credential: {credentialId}</Text>
      <Text>Scopes: {listed(scopes)}</Text>
      {expiresAt !== undefined && <Text>Expires: {expiresAt}</Text>}
    </Box>
  );
};

export const GrantUnavailableView: React.FC<ViewProps> = ({ onComplete }) => {
  useComplete(() => onComplete());
  return (
    <Box flexDirection="column">
      <Text>No session credential is required.</Text>
      <Text dimColor>This Service uses AEP JWT authentication.</Text>
    </Box>
  );
};

interface RevokeViewProps extends ViewProps {
  selector: string;
}

export const RevokeView: React.FC<RevokeViewProps> = ({ onComplete, selector }) => {
  useComplete(() => onComplete());
  return <Text color="green">Revoked {selector}</Text>;
};

interface StatusViewProps extends ViewProps {
  availableGrantTypes: string[];
  grants: StoredCredentialRow[];
  service: {
    owner_action_required?: string;
    requirements_pending?: string[];
    status: string;
    verification_pending?: string[];
  };
  serviceDid: string;
}

interface StoredCredentialRow {
  credential_id: string;
  expires_at?: string;
  grant_type: string;
  scopes: unknown;
  status: 'active';
}

function listedScopes(scopes: unknown): string {
  return Array.isArray(scopes) ? listed(scopes.filter((scope): scope is string => typeof scope === 'string')) : 'None';
}

const STORED_CREDENTIAL_COLUMNS: ReadonlyArray<TableColumn<StoredCredentialRow>> = [
  { header: 'Grant Type', cell: (row) => row.grant_type },
  { header: 'Credential ID', cell: (row) => row.credential_id },
  { header: 'Status', cell: (row) => row.status },
  { header: 'Scopes', cell: (row) => listedScopes(row.scopes) },
  { header: 'Expires', cell: (row) => row.expires_at ?? 'None' },
];

export const StatusView: React.FC<StatusViewProps> = ({
  availableGrantTypes,
  grants,
  onComplete,
  service,
  serviceDid,
}) => {
  useComplete(() => onComplete());
  const rows: DetailRow[] = [
    { field: 'Service DID', value: serviceDid },
    { field: 'Authentication', value: 'AEP JWT' },
    { field: 'Stored credentials', value: grants.length === 0 ? 'None' : String(grants.length) },
    { field: 'Available credential types', value: listed(availableGrantTypes) },
    { field: 'Owner action required', value: service.owner_action_required === 'true' ? 'Yes' : 'No' },
    { field: 'Verification pending', value: listed(service.verification_pending) },
    { field: 'Requirements pending', value: listed(service.requirements_pending) },
  ];
  return (
    <Box flexDirection="column">
      <Text bold>AEP Service Status</Text>
      <Table columns={DETAIL_COLUMNS} rows={rows} />
      {grants.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Stored Session Credentials</Text>
          <Table columns={STORED_CREDENTIAL_COLUMNS} rows={grants} />
        </Box>
      )}
    </Box>
  );
};

interface NotEnrolledViewProps extends ViewProps {
  serviceDid: string;
}

export const NotEnrolledView: React.FC<NotEnrolledViewProps> = ({ onComplete, serviceDid }) => {
  useComplete(() => onComplete());
  return (
    <Box flexDirection="column">
      <Text>Not enrolled with this Service.</Text>
      <Text dimColor>{serviceDid}</Text>
    </Box>
  );
};

export interface FetchViewProps extends ViewProps {
  authentication: string;
  body?: string;
  contentType?: string;
  finalUrl: string;
  paymentRequired?: { protocols: Array<'mpp' | 'x402'>; commands: string[] };
  responseSizeBytes: number;
  status: number;
}

export const FetchView: React.FC<FetchViewProps> = ({
  authentication,
  body,
  contentType,
  finalUrl,
  onComplete,
  paymentRequired,
  responseSizeBytes,
  status,
}) => {
  useComplete(() => onComplete());
  return (
    <Box flexDirection="column">
      <Text color={status >= 200 && status < 300 ? 'green' : 'yellow'}>{`HTTP ${String(status)}`}</Text>
      <Text>{`URL: ${finalUrl}`}</Text>
      <Text>{`Authentication: ${authentication}`}</Text>
      {paymentRequired === undefined ? null : (
        <Box flexDirection="column">
          <Text color="yellow">{`Payment required: ${paymentRequired.protocols.join(', ')}`}</Text>
          {paymentRequired.commands.map((command) => (
            <Text key={command}>{`Run: ${command}`}</Text>
          ))}
        </Box>
      )}
      {contentType === undefined ? null : <Text>{`Content type: ${contentType}`}</Text>}
      <Text>{`Response size: ${String(responseSizeBytes)} bytes`}</Text>
      {body === undefined ? null : (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Response body:</Text>
          <Text>{body}</Text>
        </Box>
      )}
    </Box>
  );
};
