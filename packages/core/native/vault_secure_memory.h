#ifndef INFLOW_VAULT_SECURE_MEMORY_H
#define INFLOW_VAULT_SECURE_MEMORY_H

#include <node_api.h>
#include <stdint.h>

#define VAULT_KEY_BYTES 32

typedef struct {
  uint8_t *memory;
  size_t allocation_size;
#if defined(_WIN32)
  int is_encrypted;
#endif
} vault_protected_key;

napi_status register_vault_secure_memory(napi_env env, napi_value exports);
int vault_protected_key_close(vault_protected_key *key);
int vault_protected_key_open(vault_protected_key *key);
void *vault_secure_allocate(size_t minimum_length, size_t *allocation_size);
void vault_secure_clear(void *value, size_t length);
void vault_secure_release(void *value, size_t allocation_size);
vault_protected_key *vault_protected_key_argument(napi_env env, napi_value value);

#endif
