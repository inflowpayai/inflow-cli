/*
 * Public API for @inflowpayai/inflow-core.
 *
 * The primary surface is the `Inflow` class. Constructing `new Inflow({...})` gives one augmented handle per command
 * group:
 *
 *   inflow.auth              IAuth              — protocol primitives + login/loginApiKey/logout/probeStatus/pollStatus
 *   inflow.user              IUser              — retrieve() (raw) + get() (agent-projected)
 *   inflow.balances          IBalanceResource   — list()
 *   inflow.depositAddresses  IDepositAddressResource — list()
 *   inflow.subscriptions     ISubscriptionResource — authorize() / list() / get() / cancel()
 *   inflow.x402              IX402              — client() (raw buyer) + pay/fetch/status/cancel/inspect/supported
 *   inflow.odp               IOdpResource        — directory search, Service inspection/navigation, federated discovery
 *
 * Plus:
 *
 *   inflow.hasApiKey()       boolean
 *   inflow.resolvedApiBaseUrl string
 *
 * Everything below is either (a) the Inflow class itself, (b) the typed interfaces and request shapes consumers
 * write functions against, (c) the reducers / phase / event / result types for callers driving their own renderer,
 * (d) the protocol primitives + helpers (sellerProbe, decodeHeader, mapSdkError, etc.). The internal runner functions
 * (`runAuthLogin`, `runPayPipeline`, etc.) are not part of the public API — callers should go through the Inflow
 * instance.
 */

/* Client + augmented interfaces ------------------------------------------- */
export { Inflow, type IAepResource, type IMppResource, type IX402Resource } from './client.js';
export {
  OdpResource,
  DirectoryRequestError,
  OdpInspectionError,
  OdpRequestError,
  PAYMENT_OPTIONS,
  type Collection,
  type CollectionGetOptions,
  type CollectionListOptions,
  type CollectionSearchOptions,
  type CollectionSequence,
  type ContinuationOptions,
  type DirectorySearchPage,
  type DirectorySearchRequest,
  type DirectoryService,
  type DirectoryServiceFilters,
  type DirectorySuggestionRequest,
  type FederatedDiscoveryEvent,
  type FederatedOfferingSearchRequest,
  type FilterDefinition,
  type IOdpResource,
  type OdpServiceClient,
  type OdpInspectOptions,
  type OdpServiceOptions,
  type OdpServiceTransportOptions,
  type Offering,
  type OfferingDetails,
  type OfferingGetOptions,
  type OfferingListOptions,
  type OfferingPage,
  type OfferingSearchOptions,
  type PageEnvelope,
  type PaymentOption,
  type PaymentProtocol,
  type ResolvedAction,
  type ResolvedSortDefinition,
  type SearchCapabilityCatalog,
  type ServiceInspection,
  type TerseCollection,
  type TerseOffering,
} from './odp.js';
export {
  augmentAuth,
  augmentMpp,
  augmentUser,
  type AuthLoginApiKeyRequest,
  type AuthLoginRequest,
  type AuthStatusPollRequest,
  type AuthStatusProbeRequest,
  type FlowRun,
  type IAuth,
  type IBalances,
  type IDepositAddresses,
  type IMpp,
  type IUser,
  type IX402,
  type MppCancelRequest,
  type MppFetchRequest,
  type MppInspectRequest,
  type MppPayRequest,
  type MppStatusRequest,
  type X402CancelRequest,
  type X402FetchRequest,
  type X402InspectRequest,
  type X402PayRequest,
  type X402StatusRequest,
} from './flows/index.js';

/* Config + errors --------------------------------------------------------- */
export type { InflowEnvironment, InflowOptions, InflowSdkLogger, ResolvedInflowSdkConfig } from './config.js';
export {
  InflowApiError,
  InflowAuthenticationError,
  InflowConfigurationError,
  InflowSdkError,
  InflowTransportError,
} from './errors.js';

/* Protocol-primitive resource interfaces ---------------------------------- */
export type {
  IAuthResource,
  IBalanceResource,
  IDepositAddressResource,
  ISubscriptionResource,
  SubscriptionListOptions,
  IUserResource,
} from './resources/interfaces.js';

/* Raw resource classes (for advanced consumers constructing resources by hand) */
export { AuthResource } from './resources/auth.js';
export { BalanceResource } from './resources/balance.js';
export { DepositAddressResource } from './resources/deposit-address.js';
export { SubscriptionResource } from './resources/subscription.js';
export { UserResource } from './resources/user.js';

/* Session, storage, sanitization, polling generic ------------------------- */
export { type AccessTokenProvider, createAccessTokenProvider, type GetAccessTokenOptions } from './session.js';
export {
  type AuthStorage,
  type ConnectionSettings,
  MemoryStorage,
  type PendingDeviceAuth,
  Storage,
  type StorageOptions,
  storage,
} from './utils/storage.js';
export { SecureStorageError, type SecureStorageErrorCode } from './secure-storage/errors.js';
export {
  MemorySecretStore,
  SecretReferenceManifest,
  SyncMemorySecretStore,
  SyncSecretReferenceManifestStore,
  type SecretReference,
  type SecureSecretStore,
  type SyncSecretReferenceManifest,
  type SyncSecureSecretStore,
} from './secure-storage/secret-store.js';
export {
  DEFAULT_VAULT_POLICY,
  type Awaitable,
  type DeleteExpiredVaultSecretsInput,
  type DeleteVaultSecretInput,
  type GetVaultSecretInput,
  type PutVaultSecretInput,
  type TouchVaultSecretInput,
  type VaultBackend,
  type VaultLockState,
  type VaultPolicy,
  type VaultSecretPayload,
  type VaultStatus,
} from './secure-storage/vault-backend.js';
export {
  type LocalVaultDaemon,
  type LocalVaultDaemonOptions,
  type LinuxVaultBrokerOptions,
  type LinuxVaultServiceOptions,
  runLinuxTransferredVaultService,
  runLinuxVaultBroker,
  runLinuxVaultService,
  runLocalVaultDaemon,
  startLinuxVaultService,
  startLocalVaultDaemon,
  systemdSocketFileDescriptor,
} from './secure-storage/vault-daemon.js';
export {
  isWindowsVaultWorkerData,
  runWindowsVaultService,
  runWindowsVaultWorker,
  type WindowsVaultWorkerData,
  type WindowsVaultServiceOptions,
} from './secure-storage/vault-windows-service.js';
export {
  LocalVaultClient,
  type LocalVaultClientOptions,
  type LocalVaultDaemonInfo,
} from './secure-storage/vault-client.js';
export { type VaultDaemonInfo } from './secure-storage/vault-daemon-handler.js';
export {
  linuxVaultServiceUserId,
  removeVaultLocalState,
  usesLinuxVaultService,
  vaultFilePaths,
  type VaultFilePaths,
} from './secure-storage/vault-files.js';
export {
  NoopSyncSecretReferenceManifest,
  SyncVaultSecretStore,
  type SyncVaultSecretStoreOptions,
} from './secure-storage/vault-sync-secret-store.js';
export {
  sendVaultIpcRequest,
  startVaultSocketServer,
  type StartMultiTenantVaultSocketServerOptions,
  type StartSingleTenantVaultSocketServerOptions,
  type StartVaultSocketServerOptions,
  type VaultSocketServer,
} from './secure-storage/vault-socket.js';
export { type VaultSocketPeer, type VaultSocketPeerVerifier } from './secure-storage/vault-peer-verifier.js';
export {
  type VaultIpcError,
  type VaultIpcMessage,
  type VaultIpcMethod,
  type VaultIpcRequest,
  type VaultIpcResponse,
} from './secure-storage/vault-ipc.js';
export {
  createVaultSecretReference,
  parseVaultSecretReference,
  type VaultRecordStatus,
  type VaultSecretKind,
  type VaultSecretReference,
} from './secure-storage/vault-types.js';
export { sanitizeDeep, sanitizeText } from './utils/sanitize-text.js';
export { sanitizeResource } from './utils/sanitize-proxy.js';
export {
  type AepCredentialDeleteSelector,
  type AepPersistedInspectResult,
  type AepOwner,
  type AepPersistedState,
  type PublicDocumentStateStorage,
  AepStorage,
  createAepPublicDocumentCache,
  type AepStateStorage,
} from './aep/storage.js';
export {
  AepFetchError,
  type AepFetchAuthentication,
  type AepFetchInput,
  type AepFetchPaymentRequired,
  type AepFetchResult,
  runAepFetch,
} from './flows/aep-fetch.js';
export { pollAsync, type PollExitReason, type PollOptions, type PollOutcome } from './utils/async-poll.js';
export { describeUser, previewAccessToken } from './utils/user-display.js';

/* Reducers, phase/event types, and snapshot types ------------------------- */
export {
  type AuthenticatedFrame,
  type AuthSnapshotFrame,
  type AuthStatusFrame,
  composeAuthSnapshot,
  type ComposeAuthSnapshotOptions,
  type PendingFrame,
  pollAuthStatus,
  type PollAuthStatusOptions,
  type TerminatedFrame,
  type UnauthenticatedFrame,
  type UpdateBlock,
} from './auth/poll.js';
export { type ProbeOutcome, type ProbeSessionOptions, probeSession } from './auth/probe.js';
export { hasSession } from './auth/session-presence.js';
export {
  type AuthLoginEvent,
  type AuthLoginInput,
  type AuthLoginPhase,
  type AuthLoginRun,
  reduceAuthLogin,
  runAuthLogin,
} from './flows/auth-login.js';
export {
  type AuthLoginApiKeyEvent,
  type AuthLoginApiKeyInput,
  type AuthLoginApiKeyPhase,
  type AuthLoginApiKeyRun,
  reduceAuthLoginApiKey,
  runAuthLoginApiKey,
} from './flows/auth-login-api-key.js';
export { type AuthLogoutInput, runAuthLogout } from './flows/auth-logout.js';
export { type AuthStatusProbeInput, type AuthStatusProbeResult, probeAuthStatus } from './flows/auth-status.js';
export {
  buildMppSection,
  buildX402Section,
  type AepSection,
  type CombinedInspectEvent,
  type CombinedInspectNoPayment,
  type CombinedInspectPhase,
  type CombinedInspectPipelineDeps,
  type CombinedInspectResult,
  type MppSection,
  type OdpSection,
  reduceCombinedInspect,
  runCombinedInspectPipeline,
  type X402Section,
} from './flows/combined-inspect.js';
export { type AcceptsSummary, decodeHeader, type DecodedHeader, summarizeAccepts } from './flows/x402-decode.js';
export {
  type InspectEvent,
  type InspectPhase,
  type InspectPipelineDeps,
  type InspectResultAccepts,
  type InspectResultNoPayment,
  parseX402HeaderFromProbe,
  reduceX402Inspect,
  runInspectPipeline,
  type X402HeaderParse,
} from './flows/x402-inspect.js';
export {
  type BodyAttachment,
  buildBodyAttachment,
  buildSettledMeta,
  mapSdkError,
  type PayEvent,
  type PayPhase,
  type PayPipelineDeps,
  type PayResultNoPayment,
  type PayResultReplayRejected,
  type PayResultSuccess,
  type PaySettledMeta,
  reducePay,
  runPayPipeline,
} from './flows/x402-pay.js';
export {
  PAYMENT_REPLAY_OUTCOME_UNKNOWN_CODE,
  PAYMENT_REPLAY_OUTCOME_UNKNOWN_MESSAGE,
  type PaymentInspectionBlocked,
  PaymentInspectionBlockedError,
  type PaymentReplayInput,
  type PaymentReplayResult,
  SellerAuthenticationError,
  type SellerRequestInput,
  type SellerRequestTransport,
  defaultSellerRequestTransport,
  replayPaymentRequest,
  sellerRequest,
} from './flows/payment-fetch.js';
export {
  type X402FetchEvent,
  type X402FetchInput,
  type X402FetchRejected,
  type X402FetchRun,
  type X402FetchSuccess,
  runX402Fetch,
} from './flows/x402-fetch.js';
export {
  classifyPayloadResponse,
  reduceX402Status,
  runX402Status,
  TERMINAL_FAILURE_STATUSES,
  type X402StatusEvent,
  type X402StatusInput,
  type X402StatusPhase,
  type X402StatusRun,
} from './flows/x402-status.js';
export { runX402Cancel, type X402CancelInput, type X402CancelResult } from './flows/x402-cancel.js';
export { runX402Supported, type X402SupportedInput } from './flows/x402-supported.js';
export {
  type DecodedChallenge,
  type DecodeResult,
  decodeChallengeRequest,
  decodeMppValue,
  summarizeChallenge,
} from './flows/mpp-decode.js';
export {
  type MppHeaderParse,
  type MppInspectEvent,
  type MppInspectPhase,
  type MppInspectPipelineDeps,
  type MppInspectResultChallenges,
  type MppInspectResultNoPayment,
  parseMppHeaderFromProbe,
  reduceMppInspect,
  runMppInspectPipeline,
} from './flows/mpp-inspect.js';
export {
  buildSettlement,
  mapMppError,
  type MppPayCreated,
  type MppPayEvent,
  type MppPayPhase,
  type MppPayPipelineDeps,
  type MppPayResultNoPayment,
  type MppPayResultRejected,
  type MppPayResultSuccess,
  type MppPaySettlement,
  reduceMppPay,
  runMppPayPipeline,
} from './flows/mpp-pay.js';
export {
  type MppFetchEvent,
  type MppFetchInput,
  type MppFetchRejected,
  type MppFetchRun,
  type MppFetchSuccess,
  runMppFetch,
} from './flows/mpp-fetch.js';
export {
  classifyTransaction,
  reduceMppStatus,
  runMppStatus,
  TERMINAL_STATES,
  type MppStatusEvent,
  type MppStatusInput,
  type MppStatusPhase,
  type MppStatusRun,
} from './flows/mpp-status.js';
export { runMppCancel, type MppCancelInput, type MppCancelResult } from './flows/mpp-cancel.js';
export { runMppSupported, type MppSupportedInput } from './flows/mpp-supported.js';
export {
  filterPayableChallenges,
  INVALID_402_CODE as MPP_INVALID_402_CODE,
  NO_FILTERED_MATCH_CODE as MPP_NO_FILTERED_MATCH_CODE,
  NO_INFLOW_MATCH_CODE as MPP_NO_INFLOW_MATCH_CODE,
  NO_INFLOW_MATCH_MESSAGE as MPP_NO_INFLOW_MATCH_MESSAGE,
  PAYMENT_NOT_ACCEPTED_CODE as MPP_PAYMENT_NOT_ACCEPTED_CODE,
  UNEXPECTED_PROBE_STATUS_CODE as MPP_UNEXPECTED_PROBE_STATUS_CODE,
} from './flows/mpp-shared.js';
export { type BalancesListInput, runBalancesList } from './flows/balances-list.js';
export { type DepositAddressesListInput, runDepositAddressesList } from './flows/deposit-addresses-list.js';
export {
  buildProfileRows,
  joinName,
  type ProfileRow,
  projectUserPayload,
  runUserGet,
  type UserAgentPayload,
  type UserGetInput,
} from './flows/user-get.js';

/* x402 helpers + shared codes --------------------------------------------- */
export { approvalUrlFor, dashboardHostFor } from './x402/dashboard-url.js';
export {
  describeBody,
  type ParsedHeaderFlag,
  parseHeaderFlag,
  parseHeaderFlags,
  type ReplayOptions,
  replayWithPayment,
  sellerProbe,
  type SellerProbeOptions,
  type SellerProbeResult,
  X402HeaderFlagFormatError,
} from '@inflowpayai/x402-buyer/probe';
export {
  type AcceptsFilters,
  buildNoFilteredMatchMessage,
  filterAccepts,
  INVALID_402_CODE,
  isSuccessStatus,
  NO_FILTERED_MATCH_CODE,
  NO_INFLOW_MATCH_CODE,
  NO_INFLOW_MATCH_MESSAGE,
  PAYMENT_NOT_ACCEPTED_CODE,
  UNEXPECTED_PROBE_STATUS_CODE,
} from './flows/x402-shared.js';

/* Server payload types ---------------------------------------------------- */
export type * from './types/index.js';
