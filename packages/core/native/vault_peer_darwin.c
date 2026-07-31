#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <node_api.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#include "vault_crypto_native.h"
#include "vault_secure_memory.h"

static napi_value make_error(napi_env env, const char *code, const char *message) {
  napi_value error;
  napi_value code_value;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &error);
  napi_create_error(env, NULL, error, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_set_named_property(env, error, "code", code_value);
  return error;
}

static napi_value peer_info(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1) {
    napi_throw(env, make_error(env, "EINVAL", "expected socket file descriptor"));
    return NULL;
  }

  int32_t fd = -1;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw(env, make_error(env, "EINVAL", "expected socket file descriptor"));
    return NULL;
  }

  pid_t pid = 0;
  socklen_t pid_len = sizeof(pid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pid_len) != 0 || pid <= 0) {
    napi_throw(env, make_error(env, "EPEERPID", strerror(errno)));
    return NULL;
  }

  uid_t uid = 0;
  gid_t gid = 0;
  if (getpeereid(fd, &uid, &gid) != 0) {
    napi_throw(env, make_error(env, "EPEERUID", strerror(errno)));
    return NULL;
  }

  char path[PROC_PIDPATHINFO_MAXSIZE];
  int path_len = proc_pidpath(pid, path, sizeof(path));
  if (path_len <= 0) {
    napi_throw(env, make_error(env, "EPEERPATH", strerror(errno)));
    return NULL;
  }

  napi_value result;
  napi_create_object(env, &result);

  napi_value pid_value;
  napi_create_int32(env, pid, &pid_value);
  napi_set_named_property(env, result, "pid", pid_value);

  napi_value uid_value;
  napi_create_uint32(env, (uint32_t)uid, &uid_value);
  napi_set_named_property(env, result, "uid", uid_value);

  napi_value path_value;
  napi_create_string_utf8(env, path, (size_t)path_len, &path_value);
  napi_set_named_property(env, result, "path", path_value);

  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value peer_info_fn;
  napi_create_function(env, "peerInfo", NAPI_AUTO_LENGTH, peer_info, NULL, &peer_info_fn);
  napi_set_named_property(env, exports, "peerInfo", peer_info_fn);
  if (register_vault_secure_memory(env, exports) != napi_ok) {
    return NULL;
  }
  if (register_vault_crypto_native(env, exports) != napi_ok) {
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
