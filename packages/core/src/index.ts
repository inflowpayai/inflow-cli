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
 *   inflow.x402              IX402              — client() (raw buyer) + pay/status/cancel/inspect/supported
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
export { Inflow, type IMppResource, type IX402Resource } from './client.js';
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
  type MppInspectRequest,
  type MppPayRequest,
  type MppStatusRequest,
  type X402CancelRequest,
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
  IUserResource,
} from './resources/interfaces.js';

/* Raw resource classes (for advanced consumers constructing resources by hand) */
export { AuthResource } from './resources/auth.js';
export { BalanceResource } from './resources/balance.js';
export { DepositAddressResource } from './resources/deposit-address.js';
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
export { sanitizeDeep, sanitizeText } from './utils/sanitize-text.js';
export { sanitizeResource } from './utils/sanitize-proxy.js';
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
export { type AcceptsSummary, decodeHeader, type DecodedHeader, summarizeAccepts } from './flows/x402-decode.js';
export {
  type InspectEvent,
  type InspectPhase,
  type InspectPipelineDeps,
  type InspectResultAccepts,
  type InspectResultNoPayment,
  reduceX402Inspect,
  runInspectPipeline,
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
  type MppInspectEvent,
  type MppInspectPhase,
  type MppInspectPipelineDeps,
  type MppInspectResultChallenges,
  type MppInspectResultNoPayment,
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
  filterInflowChallenges,
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
