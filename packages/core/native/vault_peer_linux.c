#define _GNU_SOURCE

#include <errno.h>
#include <limits.h>
#include <node_api.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
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

  struct ucred credentials;
  socklen_t credentials_length = sizeof(credentials);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &credentials_length) != 0 || credentials.pid <= 0) {
    napi_throw(env, make_error(env, "EPEERCRED", strerror(errno)));
    return NULL;
  }

  int peer_pidfd = -1;
  socklen_t peer_pidfd_length = sizeof(peer_pidfd);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERPIDFD, &peer_pidfd, &peer_pidfd_length) != 0 || peer_pidfd < 0) {
    napi_throw(env, make_error(env, "EPEERPIDFD", strerror(errno)));
    return NULL;
  }

  char proc_path[64];
  int proc_path_length = snprintf(proc_path, sizeof(proc_path), "/proc/%d/exe", credentials.pid);
  if (proc_path_length <= 0 || (size_t)proc_path_length >= sizeof(proc_path)) {
    close(peer_pidfd);
    napi_throw(env, make_error(env, "EPEERPATH", "peer executable path is unavailable"));
    return NULL;
  }

  char path[PATH_MAX];
  ssize_t path_length = readlink(proc_path, path, sizeof(path) - 1);
  if (path_length <= 0) {
    int saved_errno = errno;
    close(peer_pidfd);
    errno = saved_errno;
    napi_throw(env, make_error(env, "EPEERPATH", strerror(errno)));
    return NULL;
  }
  path[path_length] = '\0';

  struct pollfd peer_poll = {
      .fd = peer_pidfd,
      .events = POLLIN,
  };
  int poll_result = poll(&peer_poll, 1, 0);
  if (poll_result < 0 ||
      (poll_result > 0 &&
       (peer_poll.revents & (POLLIN | POLLHUP | POLLERR)) != 0)) {
    int saved_errno = poll_result < 0 ? errno : ESRCH;
    close(peer_pidfd);
    errno = saved_errno;
    napi_throw(env, make_error(env, "EPEEREXIT", strerror(errno)));
    return NULL;
  }
  close(peer_pidfd);

  napi_value result;
  napi_create_object(env, &result);

  napi_value pid_value;
  napi_create_int32(env, credentials.pid, &pid_value);
  napi_set_named_property(env, result, "pid", pid_value);

  napi_value uid_value;
  napi_create_uint32(env, (uint32_t)credentials.uid, &uid_value);
  napi_set_named_property(env, result, "uid", uid_value);

  napi_value path_value;
  napi_create_string_utf8(env, path, (size_t)path_length, &path_value);
  napi_set_named_property(env, result, "path", path_value);

  return result;
}

static napi_value peer_credentials(napi_env env, napi_callback_info info) {
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

  struct ucred credentials;
  socklen_t credentials_length = sizeof(credentials);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &credentials_length) != 0 || credentials.pid <= 0) {
    napi_throw(env, make_error(env, "EPEERCRED", strerror(errno)));
    return NULL;
  }

  napi_value result;
  napi_create_object(env, &result);

  napi_value pid_value;
  napi_create_int32(env, credentials.pid, &pid_value);
  napi_set_named_property(env, result, "pid", pid_value);

  napi_value uid_value;
  napi_create_uint32(env, (uint32_t)credentials.uid, &uid_value);
  napi_set_named_property(env, result, "uid", uid_value);

  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value peer_info_function;
  napi_create_function(env, "peerInfo", NAPI_AUTO_LENGTH, peer_info, NULL, &peer_info_function);
  napi_set_named_property(env, exports, "peerInfo", peer_info_function);
  napi_value peer_credentials_function;
  napi_create_function(env, "peerCredentials", NAPI_AUTO_LENGTH, peer_credentials, NULL, &peer_credentials_function);
  napi_set_named_property(env, exports, "peerCredentials", peer_credentials_function);
  if (register_vault_secure_memory(env, exports) != napi_ok) {
    return NULL;
  }
  if (register_vault_crypto_native(env, exports) != napi_ok) {
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
