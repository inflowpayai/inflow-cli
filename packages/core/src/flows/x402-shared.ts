import { EXTRA_KEYS } from '@inflowpayai/x402';
import type { PaymentRequired } from '@x402/core/types';

/** Error code emitted when a seller returns 402 but omits the PAYMENT-REQUIRED header. */
export const INVALID_402_CODE = 'INVALID_402';

/**
 * Error code emitted when none of the seller's accepts[] entries are signable by the InFlow buyer. The accompanying
 * message advises the user to switch to a foundation buyer client (e.g. `@x402/evm`).
 */
export const NO_INFLOW_MATCH_CODE = 'NO_INFLOW_MATCH';

export const NO_INFLOW_MATCH_MESSAGE =
  "Seller does not accept InFlow-signed payments. Use a buyer client that supports the seller's accept list (e.g., @x402/evm or @x402/svm).";

/**
 * Error code emitted when `--scheme` / `--network` / `--asset` / `--asset-name` filters narrow the accepts list to
 * empty.
 */
export const NO_FILTERED_MATCH_CODE = 'NO_FILTERED_MATCH';

/** Error code emitted when the seller signed an approval but rejected the replayed payment. */
export const PAYMENT_NOT_ACCEPTED_CODE = 'PAYMENT_NOT_ACCEPTED';

/** Error code emitted when the seller responds with neither 2xx nor 402 to the initial probe. */
export const UNEXPECTED_PROBE_STATUS_CODE = 'UNEXPECTED_PROBE_STATUS';

/**
 * Filters applied to a decoded `PaymentRequired` accepts list. Each field is matched independently against the
 * corresponding entry property; `assetName` matches `entry.extra.assetName` (the human-readable symbol the seller
 * advertises, e.g. "USDC") — the same field every InFlow scheme carries, including `balance`. All fields undefined
 * returns the input unchanged.
 */
export interface AcceptsFilters {
  scheme?: string;
  network?: string;
  asset?: string;
  assetName?: string;
}

function extractAssetName(entry: PaymentRequired['accepts'][number]): string | undefined {
  const extra = (entry as { extra?: Record<string, unknown> }).extra;
  if (extra === undefined || extra === null) return undefined;
  const assetName = extra[EXTRA_KEYS.ASSET_NAME];
  return typeof assetName === 'string' ? assetName : undefined;
}

function hasAnyFilter(filters: AcceptsFilters): boolean {
  return (
    filters.scheme !== undefined ||
    filters.network !== undefined ||
    filters.asset !== undefined ||
    filters.assetName !== undefined
  );
}

/**
 * Narrow a decoded `PaymentRequired` down to entries matching the caller's `--scheme` / `--network` / `--asset` /
 * `--asset-name` flags. Each filter is independent; all undefined returns `decoded` unchanged. The non-`accepts` fields
 * are preserved verbatim so the downstream signing context is unaffected.
 *
 * `asset` matches the on-chain asset identifier (the ERC-20 contract address for EVM, the mint pubkey for SVM).
 * `assetName` matches `entry.extra.assetName` — the human-readable symbol the seller advertises (e.g. "USDC"). This
 * field is present on every InFlow scheme (including `balance`), unlike `extra.name` (the EIP-712 domain / on-chain
 * `name()`), which only the foundation-signed `exact` schemes carry.
 */
export function filterAccepts(decoded: PaymentRequired, filters: AcceptsFilters): PaymentRequired {
  if (!hasAnyFilter(filters)) return decoded;
  const { scheme, network, asset, assetName } = filters;
  return {
    ...decoded,
    accepts: decoded.accepts.filter(
      (entry) =>
        (scheme === undefined || entry.scheme === scheme) &&
        (network === undefined || entry.network === network) &&
        (asset === undefined || entry.asset === asset) &&
        (assetName === undefined || extractAssetName(entry) === assetName),
    ),
  };
}

/**
 * Build the human-readable message for {@link NO_FILTERED_MATCH_CODE}, listing the scheme/network/asset/asset-name
 * tuples the seller actually advertises so the user can correct the flag.
 */
export function buildNoFilteredMatchMessage(decoded: PaymentRequired, filters: AcceptsFilters): string {
  const { scheme, network, asset, assetName } = filters;
  const filterDescription = [
    scheme !== undefined ? `--scheme=${scheme}` : null,
    network !== undefined ? `--network=${network}` : null,
    asset !== undefined ? `--asset=${asset}` : null,
    assetName !== undefined ? `--asset-name=${assetName}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(' ');
  const available = decoded.accepts
    .map((entry) => {
      const parts = [`${entry.scheme}/${entry.network}`];
      if (entry.asset !== undefined && entry.asset !== '') parts.push(`asset=${entry.asset}`);
      const assetName = extractAssetName(entry);
      if (assetName !== undefined && assetName !== '') parts.push(`assetName=${assetName}`);
      return parts.join(' ');
    })
    .join(', ');
  return `Seller has no accepts[] entry matching ${filterDescription}. Available: ${available || '(none)'}.`;
}

/** True when `status` is a 2xx HTTP status. */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
