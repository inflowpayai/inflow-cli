#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#include "vault_secure_memory.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#else
#include <sys/mman.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif
#include <sys/resource.h>
#include <unistd.h>
#endif

void vault_secure_clear(void *value, size_t length) {
  volatile uint8_t *bytes = value;
  while (length > 0) {
    *bytes = 0;
    bytes++;
    length--;
  }
}

void *vault_secure_allocate(size_t minimum_length, size_t *allocation_size) {
#if defined(_WIN32)
  SYSTEM_INFO system_info;
  GetSystemInfo(&system_info);
  const size_t page_size = system_info.dwPageSize;
  if (page_size == 0 || minimum_length == 0 || minimum_length > SIZE_MAX - (page_size - 1)) {
    return NULL;
  }
  *allocation_size = ((minimum_length + page_size - 1) / page_size) * page_size;
  void *memory = VirtualAlloc(NULL, *allocation_size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (memory == NULL) {
    return NULL;
  }
  if (!VirtualLock(memory, *allocation_size)) {
    VirtualFree(memory, 0, MEM_RELEASE);
    return NULL;
  }
  return memory;
#else
  long page_size = sysconf(_SC_PAGESIZE);
  if (page_size <= 0 || minimum_length == 0 || minimum_length > SIZE_MAX - ((size_t)page_size - 1)) {
    return NULL;
  }
  *allocation_size = ((minimum_length + (size_t)page_size - 1) / (size_t)page_size) * (size_t)page_size;
  void *memory = mmap(NULL, *allocation_size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (memory == MAP_FAILED) {
    return NULL;
  }
  if (mlock(memory, *allocation_size) != 0) {
    munmap(memory, *allocation_size);
    return NULL;
  }
#if defined(__linux__)
  if (madvise(memory, *allocation_size, MADV_DONTDUMP) != 0) {
    munlock(memory, *allocation_size);
    munmap(memory, *allocation_size);
    return NULL;
  }
#endif
  return memory;
#endif
}

void vault_secure_release(void *value, size_t allocation_size) {
  if (value == NULL || allocation_size == 0) {
    return;
  }
  vault_secure_clear(value, allocation_size);
#if defined(_WIN32)
  VirtualUnlock(value, allocation_size);
  VirtualFree(value, 0, MEM_RELEASE);
#else
  munlock(value, allocation_size);
  munmap(value, allocation_size);
#endif
}

int vault_protected_key_open(vault_protected_key *key) {
  if (key == NULL || key->memory == NULL) {
    return 0;
  }
#if defined(_WIN32)
  if (key->is_encrypted && !CryptUnprotectMemory(key->memory, VAULT_KEY_BYTES, CRYPTPROTECTMEMORY_SAME_PROCESS)) {
    return 0;
  }
  key->is_encrypted = 0;
#endif
  return 1;
}

int vault_protected_key_close(vault_protected_key *key) {
  if (key == NULL || key->memory == NULL) {
    return 0;
  }
#if defined(_WIN32)
  if (!key->is_encrypted && !CryptProtectMemory(key->memory, VAULT_KEY_BYTES, CRYPTPROTECTMEMORY_SAME_PROCESS)) {
    vault_secure_clear(key->memory, VAULT_KEY_BYTES);
    return 0;
  }
  key->is_encrypted = 1;
#endif
  return 1;
}

static void destroy_key(vault_protected_key *key) {
  if (key == NULL || key->memory == NULL) {
    return;
  }
  vault_secure_release(key->memory, key->allocation_size);
  key->memory = NULL;
  key->allocation_size = 0;
}

static void finalize_key(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  vault_protected_key *key = data;
  destroy_key(key);
  free(key);
}

static napi_value make_error(napi_env env, const char *code, const char *message) {
  napi_value error_message;
  napi_value error;
  napi_value code_value;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &error_message);
  napi_create_error(env, NULL, error_message, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_set_named_property(env, error, "code", code_value);
  return error;
}

vault_protected_key *vault_protected_key_argument(napi_env env, napi_value value) {
  vault_protected_key *key = NULL;
  if (napi_get_value_external(env, value, (void **)&key) != napi_ok || key == NULL || key->memory == NULL) {
    napi_throw(env, make_error(env, "EINVAL", "protected key is unavailable"));
    return NULL;
  }
  return key;
}

static napi_value create_protected_key(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw(env, make_error(env, "EINVAL", "expected 32-byte key"));
    return NULL;
  }
  bool is_typed_array = false;
  napi_is_typedarray(env, argv[0], &is_typed_array);
  if (!is_typed_array) {
    napi_throw(env, make_error(env, "EINVAL", "expected 32-byte key"));
    return NULL;
  }
  napi_typedarray_type type;
  size_t length;
  void *data;
  napi_value array_buffer;
  size_t byte_offset;
  if (napi_get_typedarray_info(env, argv[0], &type, &length, &data, &array_buffer, &byte_offset) != napi_ok ||
      type != napi_uint8_array || length != VAULT_KEY_BYTES) {
    napi_throw(env, make_error(env, "EINVAL", "expected 32-byte key"));
    return NULL;
  }

  vault_protected_key *key = calloc(1, sizeof(*key));
  if (key == NULL) {
    napi_throw(env, make_error(env, "ENOMEM", "secure memory allocation failed"));
    return NULL;
  }
  key->memory = vault_secure_allocate(VAULT_KEY_BYTES, &key->allocation_size);
  if (key->memory == NULL) {
    free(key);
    napi_throw(env, make_error(env, "ESECUREMEM", "secure memory allocation failed"));
    return NULL;
  }
  memcpy(key->memory, data, VAULT_KEY_BYTES);
  if (!vault_protected_key_close(key)) {
    destroy_key(key);
    free(key);
    napi_throw(env, make_error(env, "ESECUREMEM", "secure memory protection failed"));
    return NULL;
  }

  napi_value external;
  if (napi_create_external(env, key, finalize_key, NULL, &external) != napi_ok) {
    destroy_key(key);
    free(key);
    napi_throw(env, make_error(env, "ESECUREMEM", "secure memory handle creation failed"));
    return NULL;
  }
  return external;
}

static napi_value destroy_protected_key(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw(env, make_error(env, "EINVAL", "expected protected key"));
    return NULL;
  }
  vault_protected_key *key = NULL;
  if (napi_get_value_external(env, argv[0], (void **)&key) != napi_ok || key == NULL) {
    napi_throw(env, make_error(env, "EINVAL", "expected protected key"));
    return NULL;
  }
  destroy_key(key);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value harden_process(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0) {
    napi_throw(env, make_error(env, "EINVAL", "expected no arguments"));
    return NULL;
  }
#if defined(_WIN32)
  if (!HeapSetInformation(NULL, HeapEnableTerminationOnCorruption, NULL, 0)) {
    napi_throw(env, make_error(env, "ESECUREPROC", "process exploit mitigation failed"));
    return NULL;
  }
#if !defined(_WIN64)
  if (!SetProcessDEPPolicy(PROCESS_DEP_ENABLE | PROCESS_DEP_DISABLE_ATL_THUNK_EMULATION)) {
    napi_throw(env, make_error(env, "ESECUREPROC", "process data execution prevention failed"));
    return NULL;
  }
#endif
  PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY extension_policy = {0};
  extension_policy.DisableExtensionPoints = 1;
  PROCESS_MITIGATION_IMAGE_LOAD_POLICY image_policy = {0};
  image_policy.NoRemoteImages = 1;
  image_policy.NoLowMandatoryLabelImages = 1;
  image_policy.PreferSystem32Images = 1;
  if (!SetProcessMitigationPolicy(ProcessExtensionPointDisablePolicy, &extension_policy, sizeof(extension_policy)) ||
      !SetProcessMitigationPolicy(ProcessImageLoadPolicy, &image_policy, sizeof(image_policy))) {
    napi_throw(env, make_error(env, "ESECUREPROC", "process image policy failed"));
    return NULL;
  }
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
#else
  const struct rlimit core_limit = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core_limit) != 0) {
    napi_throw(env, make_error(env, "ESECUREPROC", "process core dump restriction failed"));
    return NULL;
  }
#if defined(__linux__)
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    napi_throw(env, make_error(env, "ESECUREPROC", "process dump restriction failed"));
    return NULL;
  }
#endif
#endif
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_status register_vault_secure_memory(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"createProtectedKey", NULL, create_protected_key, NULL, NULL, NULL, napi_default, NULL},
      {"destroyProtectedKey", NULL, destroy_protected_key, NULL, NULL, NULL, napi_default, NULL},
      {"hardenProcess", NULL, harden_process, NULL, NULL, NULL, napi_default, NULL},
  };
  return napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
}
