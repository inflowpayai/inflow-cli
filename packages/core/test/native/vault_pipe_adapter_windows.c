#include "../../native/vault_peer_windows.c"

/* The pipe fixture links real peer and memory code, without the unrelated Argon2 exports. */
napi_status register_vault_crypto_native(napi_env env, napi_value exports) {
  (void)env;
  (void)exports;
  return napi_ok;
}
