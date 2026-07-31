#include "vault_crypto_native.h"
#include "vault_secure_memory.h"

#include <argon2.h>
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#else
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/rand.h>
#endif
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define RECORD_KEY_BYTES 32
#define RECORD_NONCE_BYTES 12
#define RECORD_TAG_BYTES 16
#define VAULT_ARGON_MEMORY_KIB (64 * 1024)
#define VAULT_ARGON_TIME_COST 3
#define VAULT_SALT_BYTES 16

static const uint8_t RECORD_KEY_LABEL[] = "inflow vault record encryption";
static const uint8_t VAULT_WRAPPING_LABEL[] = "inflow vault material wrapping";

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

static int byte_array(napi_env env, napi_value value, uint8_t **data, size_t *length) {
  bool is_typed_array = false;
  if (napi_is_typedarray(env, value, &is_typed_array) != napi_ok || !is_typed_array) {
    return 0;
  }
  napi_typedarray_type type;
  napi_value array_buffer;
  size_t byte_offset;
  void *bytes;
  if (napi_get_typedarray_info(env, value, &type, length, &bytes, &array_buffer, &byte_offset) != napi_ok ||
      type != napi_uint8_array) {
    return 0;
  }
  *data = bytes;
  return 1;
}

#if defined(_WIN32)
static int hmac_sha256(
    const uint8_t *key,
    size_t key_length,
    const uint8_t *first,
    size_t first_length,
    const uint8_t *second,
    size_t second_length,
    uint8_t output[VAULT_KEY_BYTES]) {
  if (key_length > UINT32_MAX || first_length > UINT32_MAX || second_length > UINT32_MAX) {
    return 0;
  }
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  DWORD object_length = 0;
  DWORD result_length = 0;
  uint8_t *object = NULL;
  int success =
      BCryptOpenAlgorithmProvider(
          &algorithm, BCRYPT_SHA256_ALGORITHM, NULL, BCRYPT_ALG_HANDLE_HMAC_FLAG) == 0 &&
      BCryptGetProperty(
          algorithm,
          BCRYPT_OBJECT_LENGTH,
          (PUCHAR)&object_length,
          sizeof(object_length),
          &result_length,
          0) == 0 &&
      object_length > 0 &&
      (object = malloc(object_length)) != NULL &&
      BCryptCreateHash(
          algorithm, &hash, object, object_length, (PUCHAR)key, (ULONG)key_length, 0) == 0 &&
      BCryptHashData(hash, (PUCHAR)first, (ULONG)first_length, 0) == 0 &&
      BCryptHashData(hash, (PUCHAR)second, (ULONG)second_length, 0) == 0 &&
      BCryptFinishHash(hash, output, VAULT_KEY_BYTES, 0) == 0;
  if (hash != NULL) BCryptDestroyHash(hash);
  if (object != NULL) {
    vault_secure_clear(object, object_length);
    free(object);
  }
  if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
  return success;
}

static int derive_hkdf_sha256(
    const uint8_t *input,
    size_t input_length,
    const uint8_t *label,
    size_t label_length,
    uint8_t output[VAULT_KEY_BYTES]) {
  const uint8_t zero_salt[VAULT_KEY_BYTES] = {0};
  const uint8_t counter = 1;
  uint8_t pseudorandom_key[VAULT_KEY_BYTES];
  const int success =
      hmac_sha256(
          zero_salt,
          sizeof(zero_salt),
          input,
          input_length,
          zero_salt,
          0,
          pseudorandom_key) &&
      hmac_sha256(
          pseudorandom_key,
          sizeof(pseudorandom_key),
          label,
          label_length,
          &counter,
          sizeof(counter),
          output);
  vault_secure_clear(pseudorandom_key, sizeof(pseudorandom_key));
  return success;
}
#else
static int derive_hkdf_sha256(
    const uint8_t *input,
    size_t input_length,
    const uint8_t *label,
    size_t label_length,
    uint8_t output[VAULT_KEY_BYTES]) {
  int result = 0;
  EVP_PKEY_CTX *context = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, NULL);
  if (context == NULL) {
    return 0;
  }
  size_t output_length = VAULT_KEY_BYTES;
  if (EVP_PKEY_derive_init(context) > 0 &&
      EVP_PKEY_CTX_set_hkdf_md(context, EVP_sha256()) > 0 &&
      EVP_PKEY_CTX_set1_hkdf_key(context, input, input_length) > 0 &&
      EVP_PKEY_CTX_add1_hkdf_info(context, label, label_length) > 0 &&
      EVP_PKEY_derive(context, output, &output_length) > 0 && output_length == VAULT_KEY_BYTES) {
    result = 1;
  }
  EVP_PKEY_CTX_free(context);
  return result;
}
#endif

static int derive_record_key(const vault_protected_key *key, uint8_t output[RECORD_KEY_BYTES]) {
  vault_protected_key *mutable_key = (vault_protected_key *)key;
  if (!vault_protected_key_open(mutable_key)) {
    return 0;
  }
  const int result =
      derive_hkdf_sha256(
          key->memory,
          VAULT_KEY_BYTES,
          RECORD_KEY_LABEL,
          sizeof(RECORD_KEY_LABEL) - 1,
          output);
  return vault_protected_key_close(mutable_key) ? result : 0;
}

static napi_value derive_vault_wrapping_key(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) {
    napi_throw(env, make_error(env, "EINVAL", "expected unlock factor and 16-byte salt"));
    return NULL;
  }
  uint8_t *unlock_factor;
  size_t unlock_factor_length;
  uint8_t *salt;
  size_t salt_length;
  if (!byte_array(env, argv[0], &unlock_factor, &unlock_factor_length) ||
      !byte_array(env, argv[1], &salt, &salt_length) ||
      unlock_factor_length < 6 || unlock_factor_length > UINT32_MAX || salt_length != VAULT_SALT_BYTES) {
    napi_throw(env, make_error(env, "EINVAL", "unlock factor or salt is malformed"));
    return NULL;
  }

  uint8_t argon_output[VAULT_KEY_BYTES];
  uint8_t wrapping_key[VAULT_KEY_BYTES];
  size_t password_allocation_size = 0;
  uint8_t *password = vault_secure_allocate(unlock_factor_length, &password_allocation_size);
  if (password == NULL) {
    napi_throw(env, make_error(env, "ENOMEM", "vault key derivation input allocation failed"));
    return NULL;
  }
  memcpy(password, unlock_factor, unlock_factor_length);
  argon2_context context = {
      .out = argon_output,
      .outlen = sizeof(argon_output),
      .pwd = password,
      .pwdlen = (uint32_t)unlock_factor_length,
      .salt = salt,
      .saltlen = (uint32_t)salt_length,
      .secret = NULL,
      .secretlen = 0,
      .ad = NULL,
      .adlen = 0,
      .t_cost = VAULT_ARGON_TIME_COST,
      .m_cost = VAULT_ARGON_MEMORY_KIB,
      .lanes = 1,
      .threads = 1,
      .version = ARGON2_VERSION_13,
      .allocate_cbk = NULL,
      .free_cbk = NULL,
      .flags = ARGON2_FLAG_CLEAR_PASSWORD | ARGON2_FLAG_CLEAR_SECRET,
  };
  const int argon_result = argon2id_ctx(&context);
  const int success =
      argon_result == ARGON2_OK &&
      derive_hkdf_sha256(
          argon_output,
          sizeof(argon_output),
          VAULT_WRAPPING_LABEL,
          sizeof(VAULT_WRAPPING_LABEL) - 1,
          wrapping_key);
  vault_secure_release(password, password_allocation_size);
  vault_secure_clear(argon_output, sizeof(argon_output));
  if (!success) {
    vault_secure_clear(wrapping_key, sizeof(wrapping_key));
    napi_throw(env, make_error(env, "ECRYPTO", "vault key derivation failed"));
    return NULL;
  }

  napi_value result;
  if (napi_create_buffer_copy(env, sizeof(wrapping_key), wrapping_key, NULL, &result) != napi_ok) {
    vault_secure_clear(wrapping_key, sizeof(wrapping_key));
    napi_throw(env, make_error(env, "ENOMEM", "vault key derivation output failed"));
    return NULL;
  }
  vault_secure_clear(wrapping_key, sizeof(wrapping_key));
  return result;
}

#if defined(_WIN32)
static int aes_gcm(
    int encrypt,
    const uint8_t key[RECORD_KEY_BYTES],
    const uint8_t *aad,
    size_t aad_length,
    const uint8_t *input,
    size_t input_length,
    uint8_t *output,
    uint8_t nonce[RECORD_NONCE_BYTES],
    uint8_t tag[RECORD_TAG_BYTES]) {
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_KEY_HANDLE key_handle = NULL;
  DWORD key_object_length = 0;
  DWORD result_length = 0;
  ULONG output_length = 0;
  uint8_t *key_object = NULL;
  int success =
      BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_AES_ALGORITHM, NULL, 0) == 0 &&
      BCryptSetProperty(
          algorithm,
          BCRYPT_CHAINING_MODE,
          (PUCHAR)BCRYPT_CHAIN_MODE_GCM,
          sizeof(BCRYPT_CHAIN_MODE_GCM),
          0) == 0 &&
      BCryptGetProperty(
          algorithm,
          BCRYPT_OBJECT_LENGTH,
          (PUCHAR)&key_object_length,
          sizeof(key_object_length),
          &result_length,
          0) == 0 &&
      key_object_length > 0 &&
      (key_object = malloc(key_object_length)) != NULL &&
      BCryptGenerateSymmetricKey(
          algorithm,
          &key_handle,
          key_object,
          key_object_length,
          (PUCHAR)key,
          RECORD_KEY_BYTES,
          0) == 0;
  if (success && encrypt) {
    success = BCryptGenRandom(NULL, nonce, RECORD_NONCE_BYTES, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0;
  }
  BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO authentication;
  BCRYPT_INIT_AUTH_MODE_INFO(authentication);
  authentication.pbNonce = nonce;
  authentication.cbNonce = RECORD_NONCE_BYTES;
  authentication.pbAuthData = (PUCHAR)aad;
  authentication.cbAuthData = (ULONG)aad_length;
  authentication.pbTag = tag;
  authentication.cbTag = RECORD_TAG_BYTES;
  if (success) {
    const NTSTATUS status =
        encrypt
            ? BCryptEncrypt(
                  key_handle,
                  (PUCHAR)input,
                  (ULONG)input_length,
                  &authentication,
                  NULL,
                  0,
                  output,
                  (ULONG)input_length,
                  &output_length,
                  0)
            : BCryptDecrypt(
                  key_handle,
                  (PUCHAR)input,
                  (ULONG)input_length,
                  &authentication,
                  NULL,
                  0,
                  output,
                  (ULONG)input_length,
                  &output_length,
                  0);
    success = status == 0 && output_length == input_length;
  }
  if (key_handle != NULL) BCryptDestroyKey(key_handle);
  if (key_object != NULL) {
    vault_secure_clear(key_object, key_object_length);
    free(key_object);
  }
  if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
  return success;
}
#endif

static napi_value encrypt_record(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3) {
    napi_throw(env, make_error(env, "EINVAL", "expected protected key, authenticated data, and plaintext"));
    return NULL;
  }
  vault_protected_key *key = vault_protected_key_argument(env, argv[0]);
  if (key == NULL) {
    return NULL;
  }
  uint8_t *aad;
  size_t aad_length;
  uint8_t *plaintext;
  size_t plaintext_length;
  if (!byte_array(env, argv[1], &aad, &aad_length) || !byte_array(env, argv[2], &plaintext, &plaintext_length) ||
      plaintext_length > INT32_MAX || aad_length > INT32_MAX) {
    napi_throw(env, make_error(env, "EINVAL", "expected bounded byte arrays"));
    return NULL;
  }

  uint8_t record_key[RECORD_KEY_BYTES];
  uint8_t nonce[RECORD_NONCE_BYTES];
  uint8_t tag[RECORD_TAG_BYTES];
  uint8_t *ciphertext = malloc(plaintext_length == 0 ? 1 : plaintext_length);
#if !defined(_WIN32)
  EVP_CIPHER_CTX *context = NULL;
  int aad_output_length = 0;
  int output_length = 0;
  int final_length = 0;
#endif
#if defined(_WIN32)
  int success =
      ciphertext != NULL &&
      derive_record_key(key, record_key) &&
      aes_gcm(
          1,
          record_key,
          aad,
          aad_length,
          plaintext,
          plaintext_length,
          ciphertext,
          nonce,
          tag);
#else
  int success =
      ciphertext != NULL && derive_record_key(key, record_key) &&
      RAND_bytes(nonce, sizeof(nonce)) == 1 &&
      (context = EVP_CIPHER_CTX_new()) != NULL &&
      EVP_EncryptInit_ex(context, EVP_aes_256_gcm(), NULL, NULL, NULL) == 1 &&
      EVP_CIPHER_CTX_ctrl(context, EVP_CTRL_GCM_SET_IVLEN, sizeof(nonce), NULL) == 1 &&
      EVP_EncryptInit_ex(context, NULL, NULL, record_key, nonce) == 1 &&
      EVP_EncryptUpdate(context, NULL, &aad_output_length, aad, (int)aad_length) == 1 &&
      EVP_EncryptUpdate(context, ciphertext, &output_length, plaintext, (int)plaintext_length) == 1 &&
      EVP_EncryptFinal_ex(context, ciphertext + output_length, &final_length) == 1 &&
      EVP_CIPHER_CTX_ctrl(context, EVP_CTRL_GCM_GET_TAG, sizeof(tag), tag) == 1;
#endif

  vault_secure_clear(record_key, sizeof(record_key));
#if !defined(_WIN32)
  EVP_CIPHER_CTX_free(context);
#endif
  if (!success) {
    if (ciphertext != NULL) {
      vault_secure_clear(ciphertext, plaintext_length);
      free(ciphertext);
    }
    napi_throw(env, make_error(env, "ECRYPTO", "record encryption failed"));
    return NULL;
  }

  napi_value result;
  napi_value ciphertext_value;
  napi_value nonce_value;
  napi_value tag_value;
  if (napi_create_object(env, &result) != napi_ok ||
#if defined(_WIN32)
      napi_create_buffer_copy(env, plaintext_length, ciphertext, NULL, &ciphertext_value) != napi_ok ||
#else
      napi_create_buffer_copy(env, (size_t)(output_length + final_length), ciphertext, NULL, &ciphertext_value) !=
          napi_ok ||
#endif
      napi_create_buffer_copy(env, sizeof(nonce), nonce, NULL, &nonce_value) != napi_ok ||
      napi_create_buffer_copy(env, sizeof(tag), tag, NULL, &tag_value) != napi_ok ||
      napi_set_named_property(env, result, "ciphertext", ciphertext_value) != napi_ok ||
      napi_set_named_property(env, result, "nonce", nonce_value) != napi_ok ||
      napi_set_named_property(env, result, "tag", tag_value) != napi_ok) {
    vault_secure_clear(ciphertext, plaintext_length);
    free(ciphertext);
    napi_throw(env, make_error(env, "ENOMEM", "record encryption output failed"));
    return NULL;
  }
  vault_secure_clear(ciphertext, plaintext_length);
  free(ciphertext);
  return result;
}

static napi_value decrypt_record(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 5) {
    napi_throw(env, make_error(env, "EINVAL", "expected protected key, authenticated data, ciphertext, nonce, and tag"));
    return NULL;
  }
  vault_protected_key *key = vault_protected_key_argument(env, argv[0]);
  if (key == NULL) {
    return NULL;
  }
  uint8_t *aad;
  size_t aad_length;
  uint8_t *ciphertext;
  size_t ciphertext_length;
  uint8_t *nonce;
  size_t nonce_length;
  uint8_t *tag;
  size_t tag_length;
  if (!byte_array(env, argv[1], &aad, &aad_length) || !byte_array(env, argv[2], &ciphertext, &ciphertext_length) ||
      !byte_array(env, argv[3], &nonce, &nonce_length) || !byte_array(env, argv[4], &tag, &tag_length) ||
      nonce_length != RECORD_NONCE_BYTES || tag_length != RECORD_TAG_BYTES || ciphertext_length > INT32_MAX ||
      aad_length > INT32_MAX) {
    napi_throw(env, make_error(env, "EINVAL", "encrypted record fields are malformed"));
    return NULL;
  }

  uint8_t record_key[RECORD_KEY_BYTES];
  uint8_t *plaintext = malloc(ciphertext_length == 0 ? 1 : ciphertext_length);
#if !defined(_WIN32)
  EVP_CIPHER_CTX *context = NULL;
  int aad_output_length = 0;
  int output_length = 0;
  int final_length = 0;
#endif
#if defined(_WIN32)
  int success =
      plaintext != NULL &&
      derive_record_key(key, record_key) &&
      aes_gcm(
          0,
          record_key,
          aad,
          aad_length,
          ciphertext,
          ciphertext_length,
          plaintext,
          nonce,
          tag);
#else
  int success =
      plaintext != NULL && derive_record_key(key, record_key) &&
      (context = EVP_CIPHER_CTX_new()) != NULL &&
      EVP_DecryptInit_ex(context, EVP_aes_256_gcm(), NULL, NULL, NULL) == 1 &&
      EVP_CIPHER_CTX_ctrl(context, EVP_CTRL_GCM_SET_IVLEN, (int)nonce_length, NULL) == 1 &&
      EVP_DecryptInit_ex(context, NULL, NULL, record_key, nonce) == 1 &&
      EVP_DecryptUpdate(context, NULL, &aad_output_length, aad, (int)aad_length) == 1 &&
      EVP_DecryptUpdate(context, plaintext, &output_length, ciphertext, (int)ciphertext_length) == 1 &&
      EVP_CIPHER_CTX_ctrl(context, EVP_CTRL_GCM_SET_TAG, (int)tag_length, tag) == 1 &&
      EVP_DecryptFinal_ex(context, plaintext + output_length, &final_length) == 1;
#endif

  vault_secure_clear(record_key, sizeof(record_key));
#if !defined(_WIN32)
  EVP_CIPHER_CTX_free(context);
#endif
  if (!success) {
    if (plaintext != NULL) {
      vault_secure_clear(plaintext, ciphertext_length);
      free(plaintext);
    }
    napi_throw(env, make_error(env, "EAUTH", "record authentication failed"));
    return NULL;
  }

  napi_value result;
  if (napi_create_buffer_copy(
          env,
#if defined(_WIN32)
          ciphertext_length,
#else
          (size_t)(output_length + final_length),
#endif
          plaintext,
          NULL,
          &result) != napi_ok) {
    vault_secure_clear(plaintext, ciphertext_length);
    free(plaintext);
    napi_throw(env, make_error(env, "ENOMEM", "record decryption output failed"));
    return NULL;
  }
  vault_secure_clear(plaintext, ciphertext_length);
  free(plaintext);
  return result;
}

napi_status register_vault_crypto_native(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"decryptRecord", NULL, decrypt_record, NULL, NULL, NULL, napi_default, NULL},
      {"deriveVaultWrappingKey", NULL, derive_vault_wrapping_key, NULL, NULL, NULL, napi_default, NULL},
      {"encryptRecord", NULL, encrypt_record, NULL, NULL, NULL, napi_default, NULL},
  };
  return napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
}
