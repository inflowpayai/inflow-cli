#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
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

static napi_value listener_info(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  char socket_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
  size_t length = 0;
  struct stat before, after, parent;
  pid_t *pids = NULL;
  struct proc_fdinfo *fds = NULL;
  pid_t owner = 0;
  int owner_fd = -1;
  uint64_t owner_socket = 0;
  struct proc_bsdinfo owner_process = {0};
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok ||
      length == 0 || length >= sizeof(socket_path) ||
      napi_get_value_string_utf8(env, argv[0], socket_path, sizeof(socket_path), &length) != napi_ok ||
      strlen(socket_path) != length || socket_path[0] != '/') goto failure;
  if (lstat(socket_path, &before) != 0 || !S_ISSOCK(before.st_mode) || before.st_uid != getuid()) goto failure;
  char parent_path[sizeof(socket_path)];
  memcpy(parent_path, socket_path, length + 1);
  *strrchr(parent_path, '/') = '\0';
  if (lstat(parent_path, &parent) != 0 || !S_ISDIR(parent.st_mode) || parent.st_uid != getuid() ||
      (parent.st_mode & 0022) != 0) goto failure;

  int pid_bytes = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
  if (pid_bytes <= 0 || pid_bytes > 1024 * 1024) goto failure;
  pid_bytes += 4096;
  pids = malloc((size_t)pid_bytes);
  if (pids == NULL) goto failure;
  int pid_used = proc_listpids(PROC_UID_ONLY, getuid(), pids, pid_bytes);
  if (pid_used <= 0 || pid_used >= pid_bytes || pid_used % sizeof(pid_t) != 0) goto failure;
  for (size_t i = 0; i < (size_t)pid_used / sizeof(pid_t); i++) {
    if (pids[i] <= 0) continue;
    int fd_bytes = proc_pidinfo(pids[i], PROC_PIDLISTFDS, 0, NULL, 0);
    if (fd_bytes <= 0) {
      if (errno == EPERM || errno == EACCES) goto failure;
      continue;
    }
    if (fd_bytes > 16 * 1024 * 1024) goto failure;
    fd_bytes += (int)(64 * sizeof(struct proc_fdinfo));
    fds = malloc((size_t)fd_bytes);
    if (fds == NULL) goto failure;
    int fd_used = proc_pidinfo(pids[i], PROC_PIDLISTFDS, 0, fds, fd_bytes);
    if (fd_used <= 0 && (errno == EPERM || errno == EACCES)) goto failure;
    if (fd_used >= fd_bytes || (fd_used > 0 && fd_used % sizeof(struct proc_fdinfo) != 0)) goto failure;
    for (size_t j = 0; fd_used > 0 && j < (size_t)fd_used / sizeof(struct proc_fdinfo); j++) {
      if (fds[j].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
      struct socket_fdinfo socket;
      if (proc_pidfdinfo(pids[i], fds[j].proc_fd, PROC_PIDFDSOCKETINFO, &socket, sizeof(socket)) != sizeof(socket)) {
        if (errno == EPERM || errno == EACCES) goto failure;
        continue;
      }
      if (socket.psi.soi_family != AF_UNIX || socket.psi.soi_kind != SOCKINFO_UN ||
          !(socket.psi.soi_options & SO_ACCEPTCONN) ||
          strncmp(socket.psi.soi_proto.pri_un.unsi_addr.ua_sun.sun_path, socket_path, sizeof(socket_path)) != 0)
        continue;
      if (owner != 0) goto failure;
      owner = pids[i];
      owner_fd = fds[j].proc_fd;
      owner_socket = socket.psi.soi_so;
      if (proc_pidinfo(owner, PROC_PIDTBSDINFO, 0, &owner_process, sizeof(owner_process)) != sizeof(owner_process) ||
          owner_process.pbi_uid != getuid()) goto failure;
    }
    free(fds);
    fds = NULL;
  }
  free(pids);
  pids = NULL;
  if (owner == 0) goto failure;

  char path[PROC_PIDPATHINFO_MAXSIZE];
  int path_len = proc_pidpath(owner, path, sizeof(path));
  struct proc_bsdinfo current_process;
  struct socket_fdinfo current_socket;
  if (path_len <= 0 ||
      proc_pidinfo(owner, PROC_PIDTBSDINFO, 0, &current_process, sizeof(current_process)) != sizeof(current_process) ||
      current_process.pbi_uid != owner_process.pbi_uid ||
      current_process.pbi_start_tvsec != owner_process.pbi_start_tvsec ||
      current_process.pbi_start_tvusec != owner_process.pbi_start_tvusec ||
      proc_pidfdinfo(owner, owner_fd, PROC_PIDFDSOCKETINFO, &current_socket, sizeof(current_socket)) != sizeof(current_socket) ||
      current_socket.psi.soi_so != owner_socket || !(current_socket.psi.soi_options & SO_ACCEPTCONN) ||
      lstat(socket_path, &after) != 0 || before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_uid != after.st_uid || !S_ISSOCK(after.st_mode)) goto failure;

  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_int32(env, owner, &value);
  napi_set_named_property(env, result, "pid", value);
  napi_create_uint32(env, owner_process.pbi_uid, &value);
  napi_set_named_property(env, result, "uid", value);
  napi_create_string_utf8(env, path, (size_t)path_len, &value);
  napi_set_named_property(env, result, "path", value);
  return result;

failure:
  free(fds);
  free(pids);
  napi_throw(env, make_error(env, "EPEERLISTENER", "Vault listener ownership could not be verified."));
  return NULL;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value peer_info_fn;
  napi_create_function(env, "peerInfo", NAPI_AUTO_LENGTH, peer_info, NULL, &peer_info_fn);
  napi_set_named_property(env, exports, "peerInfo", peer_info_fn);
  napi_value listener_info_fn;
  napi_create_function(env, "listenerInfo", NAPI_AUTO_LENGTH, listener_info, NULL, &listener_info_fn);
  napi_set_named_property(env, exports, "listenerInfo", listener_info_fn);
  if (register_vault_secure_memory(env, exports) != napi_ok) {
    return NULL;
  }
  if (register_vault_crypto_native(env, exports) != napi_ok) {
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
