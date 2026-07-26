#define WIN32_LEAN_AND_MEAN

#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <uchar.h>
#include <uv.h>
#include <wchar.h>
#include <windows.h>
#include <bcrypt.h>
#include <aclapi.h>
#include <sddl.h>
#include <softpub.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <wtsapi32.h>

#include "vault_crypto_native.h"
#include "vault_secure_memory.h"

#define VAULT_IPC_MAX_FRAME_BYTES (4 + 1024 * 1024)

typedef struct vault_pipe_connection {
  HANDLE handle;
} vault_pipe_connection;

static const uint8_t vault_pipe_handshake[] = {'I', 'N', 'F', 'L', 'O', 'W', 'V', '1'};

static HANDLE service_ready_event = NULL;
static HANDLE service_stopped_event = NULL;
static volatile LONG service_stop_requested = 0;
static volatile LONG service_lock_requested = 0;
static SERVICE_STATUS_HANDLE service_status_handle = NULL;
static SRWLOCK service_io_lock = SRWLOCK_INIT;
static HANDLE service_io_thread = NULL;

static int begin_service_io(void) {
  HANDLE thread = NULL;
  if (!DuplicateHandle(
          GetCurrentProcess(),
          GetCurrentThread(),
          GetCurrentProcess(),
          &thread,
          0,
          FALSE,
          DUPLICATE_SAME_ACCESS)) {
    return 0;
  }
  AcquireSRWLockExclusive(&service_io_lock);
  if (service_io_thread != NULL) {
    CloseHandle(service_io_thread);
  }
  service_io_thread = thread;
  ReleaseSRWLockExclusive(&service_io_lock);
  return 1;
}

static void end_service_io(void) {
  AcquireSRWLockExclusive(&service_io_lock);
  if (service_io_thread != NULL) {
    CloseHandle(service_io_thread);
    service_io_thread = NULL;
  }
  ReleaseSRWLockExclusive(&service_io_lock);
}

static void cancel_service_io(void) {
  AcquireSRWLockShared(&service_io_lock);
  if (service_io_thread != NULL) {
    CancelSynchronousIo(service_io_thread);
  }
  ReleaseSRWLockShared(&service_io_lock);
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

static void report_service_status(DWORD state, DWORD controls, DWORD exit_code, DWORD wait_hint) {
  if (service_status_handle == NULL) return;
  SERVICE_STATUS status = {
      .dwServiceType = SERVICE_WIN32_OWN_PROCESS,
      .dwCurrentState = state,
      .dwControlsAccepted = controls,
      .dwWin32ExitCode = exit_code,
      .dwWaitHint = wait_hint,
  };
  SetServiceStatus(service_status_handle, &status);
}

static DWORD WINAPI vault_service_control(
    DWORD control,
    DWORD event_type,
    LPVOID event_data,
    LPVOID context) {
  (void)event_data;
  (void)context;
  if (control == SERVICE_CONTROL_STOP) {
    InterlockedExchange(&service_stop_requested, 1);
    report_service_status(SERVICE_STOP_PENDING, 0, NO_ERROR, 20000);
    cancel_service_io();
    return NO_ERROR;
  }
  if (control == SERVICE_CONTROL_POWEREVENT && event_type == PBT_APMSUSPEND) {
    InterlockedExchange(&service_lock_requested, 1);
    return NO_ERROR;
  }
  if (control == SERVICE_CONTROL_INTERROGATE) return NO_ERROR;
  return ERROR_CALL_NOT_IMPLEMENTED;
}

static void WINAPI vault_service_main(DWORD argc, LPWSTR *argv) {
  (void)argc;
  (void)argv;
  service_status_handle =
      RegisterServiceCtrlHandlerExW(L"InFlowVault", vault_service_control, NULL);
  if (service_status_handle == NULL) return;
  report_service_status(SERVICE_START_PENDING, 0, NO_ERROR, 20000);
  if (WaitForSingleObject(service_ready_event, 20000) != WAIT_OBJECT_0) {
    InterlockedExchange(&service_stop_requested, 1);
    cancel_service_io();
    report_service_status(SERVICE_STOPPED, 0, ERROR_SERVICE_REQUEST_TIMEOUT, 0);
    return;
  }
  report_service_status(
      SERVICE_RUNNING,
      SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_POWEREVENT,
      NO_ERROR,
      0);
  WaitForSingleObject(service_stopped_event, INFINITE);
  report_service_status(SERVICE_STOPPED, 0, NO_ERROR, 0);
}

static int initialize_service_events(void) {
  if (service_ready_event != NULL && service_stopped_event != NULL) return 1;
  service_ready_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  service_stopped_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  return service_ready_event != NULL && service_stopped_event != NULL;
}

static int peer_process_id(HANDLE pipe, ULONG *pid) {
  if (GetNamedPipeClientProcessId(pipe, pid) && *pid > 0) {
    return 1;
  }
  *pid = 0;
  return GetNamedPipeServerProcessId(pipe, pid) && *pid > 0;
}

static int process_path(HANDLE process, wchar_t **path, DWORD *length) {
  DWORD capacity = 32768;
  wchar_t *value = calloc(capacity, sizeof(*value));
  if (value == NULL) {
    return 0;
  }
  if (!QueryFullProcessImageNameW(process, 0, value, &capacity) || capacity == 0) {
    free(value);
    return 0;
  }
  *path = value;
  *length = capacity;
  return 1;
}

static int sid_string(PSID sid, wchar_t **result) {
  if (!IsValidSid(sid)) {
    return 0;
  }
  const SID_IDENTIFIER_AUTHORITY *authority = GetSidIdentifierAuthority(sid);
  const UCHAR sub_authority_count = *GetSidSubAuthorityCount(sid);
  wchar_t *value = calloc(256, sizeof(*value));
  if (value == NULL) {
    return 0;
  }
  int written;
  if (authority->Value[0] != 0 || authority->Value[1] != 0) {
    written = swprintf_s(
        value,
        256,
        L"S-%u-0x%02x%02x%02x%02x%02x%02x",
        SID_REVISION,
        authority->Value[0],
        authority->Value[1],
        authority->Value[2],
        authority->Value[3],
        authority->Value[4],
        authority->Value[5]);
  } else {
    const ULONG authority_value =
        ((ULONG)authority->Value[2] << 24) |
        ((ULONG)authority->Value[3] << 16) |
        ((ULONG)authority->Value[4] << 8) |
        (ULONG)authority->Value[5];
    written = swprintf_s(value, 256, L"S-%u-%lu", SID_REVISION, authority_value);
  }
  if (written <= 0) {
    free(value);
    return 0;
  }
  size_t offset = (size_t)written;
  for (UCHAR index = 0; index < sub_authority_count; index++) {
    written = swprintf_s(value + offset, 256 - offset, L"-%lu", *GetSidSubAuthority(sid, index));
    if (written <= 0) {
      free(value);
      return 0;
    }
    offset += (size_t)written;
  }
  *result = value;
  return 1;
}

static int token_sid(HANDLE token, wchar_t **sid) {
  DWORD required = 0;
  TOKEN_USER *user = NULL;
  GetTokenInformation(token, TokenUser, NULL, 0, &required);
  if (required == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    return 0;
  }
  user = malloc(required);
  if (user == NULL || !GetTokenInformation(token, TokenUser, user, required, &required) ||
      !sid_string(user->User.Sid, sid)) {
    free(user);
    return 0;
  }
  free(user);
  return 1;
}

static int process_sid(HANDLE process, wchar_t **sid) {
  HANDLE token = NULL;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) {
    return 0;
  }
  const int success = token_sid(token, sid);
  CloseHandle(token);
  return success;
}

static int pipe_client_identity(
    HANDLE pipe,
    ULONG observed_pid,
    wchar_t **path,
    DWORD *path_length,
    wchar_t **sid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, observed_pid);
  if (process == NULL) {
    return 0;
  }
  int success = process_path(process, path, path_length);
  CloseHandle(process);
  if (!success || !ImpersonateNamedPipeClient(pipe)) {
    free(*path);
    *path = NULL;
    return 0;
  }
  HANDLE token = NULL;
  ULONG confirmed_pid = 0;
  success =
      OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token) &&
      token_sid(token, sid) &&
      peer_process_id(pipe, &confirmed_pid) &&
      confirmed_pid == observed_pid;
  if (token != NULL) {
    CloseHandle(token);
  }
  if (!RevertToSelf()) {
    success = 0;
  }
  if (!success) {
    free(*path);
    free(*sid);
    *path = NULL;
    *sid = NULL;
  }
  return success;
}

static int allow_service_process_query(void) {
  DWORD sid_length = 0;
  DWORD domain_length = 0;
  SID_NAME_USE sid_type;
  LookupAccountNameW(
      NULL,
      L"NT SERVICE\\InFlowVault",
      NULL,
      &sid_length,
      NULL,
      &domain_length,
      &sid_type);
  if (sid_length == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    return 0;
  }
  PSID service_sid = malloc(sid_length);
  wchar_t *domain = calloc(domain_length + 1, sizeof(*domain));
  if (service_sid == NULL || domain == NULL ||
      !LookupAccountNameW(
          NULL,
          L"NT SERVICE\\InFlowVault",
          service_sid,
          &sid_length,
          domain,
          &domain_length,
          &sid_type)) {
    free(service_sid);
    free(domain);
    return 0;
  }
  PACL existing_dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD status = GetSecurityInfo(
      GetCurrentProcess(),
      SE_KERNEL_OBJECT,
      DACL_SECURITY_INFORMATION,
      NULL,
      NULL,
      &existing_dacl,
      NULL,
      &descriptor);
  PACL updated_dacl = NULL;
  if (status == ERROR_SUCCESS) {
    EXPLICIT_ACCESSW access = {
        .grfAccessPermissions = PROCESS_QUERY_LIMITED_INFORMATION,
        .grfAccessMode = GRANT_ACCESS,
        .grfInheritance = NO_INHERITANCE,
        .Trustee = {
            .pMultipleTrustee = NULL,
            .MultipleTrusteeOperation = NO_MULTIPLE_TRUSTEE,
            .TrusteeForm = TRUSTEE_IS_SID,
            .TrusteeType = TRUSTEE_IS_USER,
            .ptstrName = service_sid,
        },
    };
    status = SetEntriesInAclW(1, &access, existing_dacl, &updated_dacl);
  }
  if (status == ERROR_SUCCESS) {
    status = SetSecurityInfo(
        GetCurrentProcess(),
        SE_KERNEL_OBJECT,
        DACL_SECURITY_INFORMATION,
        NULL,
        NULL,
        updated_dacl,
        NULL);
  }
  if (updated_dacl != NULL) {
    LocalFree(updated_dacl);
  }
  if (descriptor != NULL) {
    LocalFree(descriptor);
  }
  free(service_sid);
  free(domain);
  return status == ERROR_SUCCESS;
}

static int pipe_peer_identity(
    HANDLE pipe,
    int peer_is_client,
    ULONG *pid,
    wchar_t **path,
    DWORD *path_length,
    wchar_t **sid) {
  ULONG observed_pid = 0;
  if (!peer_process_id(pipe, &observed_pid)) {
    return 0;
  }
  if (peer_is_client) {
    if (!pipe_client_identity(pipe, observed_pid, path, path_length, sid)) {
      return 0;
    }
    *pid = observed_pid;
    return 1;
  }
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, observed_pid);
  if (process == NULL) {
    return 0;
  }
  ULONG confirmed_pid = 0;
  const int success =
      peer_process_id(pipe, &confirmed_pid) &&
      confirmed_pid == observed_pid &&
      process_path(process, path, path_length) &&
      process_sid(process, sid);
  CloseHandle(process);
  if (!success) {
    free(*path);
    free(*sid);
    *path = NULL;
    *sid = NULL;
    return 0;
  }
  *pid = observed_pid;
  return 1;
}

static napi_value peer_identity_value(
    napi_env env,
    ULONG pid,
    const wchar_t *path,
    DWORD path_length,
    const wchar_t *sid) {
  napi_value result;
  napi_value path_value;
  napi_value pid_value;
  napi_value principal_value;
  napi_value uid_value;
  napi_create_object(env, &result);
  napi_create_string_utf16(env, (const char16_t *)path, path_length, &path_value);
  napi_create_uint32(env, pid, &pid_value);
  napi_create_string_utf16(env, (const char16_t *)sid, NAPI_AUTO_LENGTH, &principal_value);
  napi_create_uint32(env, 0, &uid_value);
  napi_set_named_property(env, result, "path", path_value);
  napi_set_named_property(env, result, "pid", pid_value);
  napi_set_named_property(env, result, "principal", principal_value);
  napi_set_named_property(env, result, "uid", uid_value);
  return result;
}

static int read_exact(HANDLE pipe, uint8_t *buffer, DWORD length) {
  DWORD offset = 0;
  while (offset < length) {
    DWORD bytes_read = 0;
    if (!ReadFile(pipe, buffer + offset, length - offset, &bytes_read, NULL) || bytes_read == 0) {
      return 0;
    }
    offset += bytes_read;
  }
  return 1;
}

static int write_exact(HANDLE pipe, const uint8_t *buffer, DWORD length) {
  DWORD offset = 0;
  while (offset < length) {
    DWORD bytes_written = 0;
    if (!WriteFile(pipe, buffer + offset, length - offset, &bytes_written, NULL) || bytes_written == 0) {
      return 0;
    }
    offset += bytes_written;
  }
  return FlushFileBuffers(pipe);
}

static int read_frame(HANDLE pipe, uint8_t **frame, DWORD *frame_length) {
  uint8_t length_bytes[4];
  if (!read_exact(pipe, length_bytes, sizeof(length_bytes))) {
    return 0;
  }
  const uint32_t body_length =
      ((uint32_t)length_bytes[0] << 24) |
      ((uint32_t)length_bytes[1] << 16) |
      ((uint32_t)length_bytes[2] << 8) |
      (uint32_t)length_bytes[3];
  if (body_length == 0 || body_length > VAULT_IPC_MAX_FRAME_BYTES - sizeof(length_bytes)) {
    SetLastError(ERROR_INVALID_DATA);
    return 0;
  }
  const DWORD total_length = (DWORD)sizeof(length_bytes) + body_length;
  uint8_t *value = malloc(total_length);
  if (value == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return 0;
  }
  memcpy(value, length_bytes, sizeof(length_bytes));
  if (!read_exact(pipe, value + sizeof(length_bytes), body_length)) {
    vault_secure_clear(value, total_length);
    free(value);
    return 0;
  }
  *frame = value;
  *frame_length = total_length;
  return 1;
}

static int string_argument(napi_env env, napi_value value, wchar_t **result) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok || length == 0 ||
      length > 32767) {
    return 0;
  }
  wchar_t *text = calloc(length + 1, sizeof(*text));
  if (text == NULL ||
      napi_get_value_string_utf16(env, value, (char16_t *)text, length + 1, &length) != napi_ok) {
    free(text);
    return 0;
  }
  *result = text;
  return 1;
}

static int bytes_argument(napi_env env, napi_value value, uint8_t **data, size_t *length) {
  bool is_buffer = false;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, value, (void **)data, length) != napi_ok ||
      *length < 4 || *length > VAULT_IPC_MAX_FRAME_BYTES) {
    return 0;
  }
  return 1;
}

static void close_connection(vault_pipe_connection *connection) {
  if (connection == NULL) {
    return;
  }
  if (connection->handle != INVALID_HANDLE_VALUE) {
    CloseHandle(connection->handle);
    connection->handle = INVALID_HANDLE_VALUE;
  }
}

static void finalize_connection(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  vault_pipe_connection *connection = data;
  close_connection(connection);
  free(connection);
}

static napi_value connection_result(
    napi_env env,
    HANDLE pipe,
    ULONG pid,
    const wchar_t *path,
    DWORD path_length,
    const wchar_t *sid) {
  vault_pipe_connection *connection = calloc(1, sizeof(*connection));
  if (connection == NULL) {
    return NULL;
  }
  connection->handle = pipe;
  napi_value connection_value;
  napi_value result;
  napi_create_external(env, connection, finalize_connection, NULL, &connection_value);
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "connection", connection_value);
  napi_set_named_property(env, result, "peer", peer_identity_value(env, pid, path, path_length, sid));
  return result;
}

static napi_value accept_pipe_connection(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  wchar_t *pipe_name = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  HANDLE pipe = INVALID_HANDLE_VALUE;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      !string_argument(env, argv[0], &pipe_name)) {
    napi_throw(env, make_error(env, "EINVAL", "expected named pipe path"));
    return NULL;
  }
  const wchar_t *security =
      L"D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)";
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          security, SDDL_REVISION_1, &descriptor, NULL)) {
    free(pipe_name);
    napi_throw(env, make_error(env, "EPIPESECURITY", "named pipe security initialization failed"));
    return NULL;
  }
  SECURITY_ATTRIBUTES attributes = {
      .nLength = sizeof(attributes),
      .lpSecurityDescriptor = descriptor,
      .bInheritHandle = FALSE,
  };
  pipe = CreateNamedPipeW(
      pipe_name,
      PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1,
      VAULT_IPC_MAX_FRAME_BYTES,
      VAULT_IPC_MAX_FRAME_BYTES,
      0,
      &attributes);
  LocalFree(descriptor);
  free(pipe_name);
  if (pipe == INVALID_HANDLE_VALUE) {
    napi_throw(env, make_error(env, "EPIPECREATE", "named pipe creation failed"));
    return NULL;
  }
  if (!begin_service_io()) {
    CloseHandle(pipe);
    napi_throw(env, make_error(env, "EPIPECANCEL", "named pipe cancellation initialization failed"));
    return NULL;
  }
  if (!ConnectNamedPipe(pipe, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) {
    end_service_io();
    CloseHandle(pipe);
    napi_throw(env, make_error(env, "EPIPECONNECT", "named pipe connection failed"));
    return NULL;
  }

  ULONG pid = 0;
  uint8_t handshake[sizeof(vault_pipe_handshake)];
  wchar_t *path = NULL;
  wchar_t *sid = NULL;
  DWORD path_length = 0;
  if (!read_exact(pipe, handshake, sizeof(handshake)) ||
      memcmp(handshake, vault_pipe_handshake, sizeof(handshake)) != 0) {
    end_service_io();
    CloseHandle(pipe);
    napi_throw(env, make_error(env, "EPIPEHANDSHAKE", "named pipe authentication handshake failed"));
    return NULL;
  }
  end_service_io();
  if (!pipe_peer_identity(pipe, 1, &pid, &path, &path_length, &sid)) {
    free(path);
    free(sid);
    CloseHandle(pipe);
    napi_throw(env, make_error(env, "EPIPEPEER", "named pipe client verification failed"));
    return NULL;
  }

  napi_value result = connection_result(env, pipe, pid, path, path_length, sid);
  free(path);
  free(sid);
  if (result == NULL) {
    CloseHandle(pipe);
    napi_throw(env, make_error(env, "ENOMEM", "named pipe connection allocation failed"));
    return NULL;
  }
  return result;
}

static vault_pipe_connection *connection_argument(napi_env env, napi_value value) {
  vault_pipe_connection *connection = NULL;
  if (napi_get_value_external(env, value, (void **)&connection) != napi_ok ||
      connection == NULL || connection->handle == INVALID_HANDLE_VALUE) {
    return NULL;
  }
  return connection;
}

static napi_value close_pipe_connection(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw(env, make_error(env, "EINVAL", "expected named pipe connection"));
    return NULL;
  }
  vault_pipe_connection *connection = connection_argument(env, argv[0]);
  if (connection == NULL) {
    napi_throw(env, make_error(env, "EINVAL", "expected named pipe connection"));
    return NULL;
  }
  close_connection(connection);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value begin_pipe_session(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw(env, make_error(env, "EINVAL", "expected named pipe connection"));
    return NULL;
  }
  vault_pipe_connection *connection = connection_argument(env, argv[0]);
  if (connection == NULL ||
      !write_exact(connection->handle, vault_pipe_handshake, sizeof(vault_pipe_handshake))) {
    napi_throw(env, make_error(env, "EPIPEHANDSHAKE", "named pipe authentication handshake failed"));
    return NULL;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value read_pipe_request(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw(env, make_error(env, "EINVAL", "expected named pipe connection"));
    return NULL;
  }
  vault_pipe_connection *connection = connection_argument(env, argv[0]);
  uint8_t *frame = NULL;
  DWORD frame_length = 0;
  if (connection == NULL) {
    napi_throw(env, make_error(env, "EPIPEREAD", "named pipe request failed"));
    return NULL;
  }
  if (!begin_service_io()) {
    napi_throw(env, make_error(env, "EPIPECANCEL", "named pipe cancellation initialization failed"));
    return NULL;
  }
  const int success = read_frame(connection->handle, &frame, &frame_length);
  end_service_io();
  if (!success) {
    napi_throw(env, make_error(env, "EPIPEREAD", "named pipe request failed"));
    return NULL;
  }
  napi_value result;
  napi_create_buffer_copy(env, frame_length, frame, NULL, &result);
  vault_secure_clear(frame, frame_length);
  free(frame);
  return result;
}

static napi_value write_pipe_response(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  vault_pipe_connection *connection = NULL;
  uint8_t *frame = NULL;
  size_t frame_length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      (connection = connection_argument(env, argv[0])) == NULL ||
      !bytes_argument(env, argv[1], &frame, &frame_length)) {
    napi_throw(env, make_error(env, "EINVAL", "expected named pipe connection and frame"));
    return NULL;
  }
  if (!begin_service_io()) {
    napi_throw(env, make_error(env, "EPIPECANCEL", "named pipe cancellation initialization failed"));
    return NULL;
  }
  const int success = write_exact(connection->handle, frame, (DWORD)frame_length);
  end_service_io();
  DisconnectNamedPipe(connection->handle);
  close_connection(connection);
  if (!success) {
    napi_throw(env, make_error(env, "EPIPEWRITE", "named pipe response failed"));
    return NULL;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value connect_pipe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  wchar_t *pipe_name = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      !string_argument(env, argv[0], &pipe_name)) {
    free(pipe_name);
      napi_throw(env, make_error(env, "EINVAL", "expected named pipe path"));
    return NULL;
  }
  if (!allow_service_process_query()) {
    free(pipe_name);
    napi_throw(env, make_error(env, "EPIPEACL", "vault service process verification could not be authorized"));
    return NULL;
  }
  SC_HANDLE manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
  SC_HANDLE service =
      manager == NULL ? NULL : OpenServiceW(manager, L"InFlowVault", SERVICE_START | SERVICE_QUERY_STATUS);
  if (service == NULL ||
      (!StartServiceW(service, 0, NULL) && GetLastError() != ERROR_SERVICE_ALREADY_RUNNING)) {
    if (service != NULL) CloseServiceHandle(service);
    if (manager != NULL) CloseServiceHandle(manager);
    free(pipe_name);
    napi_throw(env, make_error(env, "ESERVICESTART", "vault service could not be started"));
    return NULL;
  }
  CloseServiceHandle(service);
  CloseServiceHandle(manager);
  const ULONGLONG pipe_deadline = GetTickCount64() + 25000;
  HANDLE pipe = INVALID_HANDLE_VALUE;
  while (pipe == INVALID_HANDLE_VALUE) {
    if (WaitNamedPipeW(pipe_name, 250)) {
      pipe = CreateFileW(
          pipe_name,
          GENERIC_READ | GENERIC_WRITE,
          0,
          NULL,
          OPEN_EXISTING,
          SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
          NULL);
      if (pipe != INVALID_HANDLE_VALUE) {
        break;
      }
    }
    const DWORD error = GetLastError();
    if ((error != ERROR_FILE_NOT_FOUND && error != ERROR_PIPE_BUSY && error != ERROR_SEM_TIMEOUT) ||
        GetTickCount64() >= pipe_deadline) {
      free(pipe_name);
      napi_throw(env, make_error(env, "EPIPEWAIT", "named pipe service is unavailable"));
      return NULL;
    }
    Sleep(50);
  }
  free(pipe_name);

  ULONG pid = 0;
  wchar_t *path = NULL;
  wchar_t *sid = NULL;
  DWORD path_length = 0;
  if (!pipe_peer_identity(pipe, 0, &pid, &path, &path_length, &sid)) {
    free(path);
    free(sid);
    CloseHandle(pipe);
    napi_throw(env, make_error(env, "EPIPEPEER", "named pipe server verification failed"));
    return NULL;
  }
  napi_value result = connection_result(env, pipe, pid, path, path_length, sid);
  free(path);
  free(sid);
  if (result == NULL) {
    CloseHandle(pipe);
    napi_throw(env, make_error(env, "ENOMEM", "named pipe connection allocation failed"));
    return NULL;
  }
  return result;
}

static napi_value exchange_pipe_request(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  vault_pipe_connection *connection = NULL;
  uint8_t *request = NULL;
  size_t request_length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      (connection = connection_argument(env, argv[0])) == NULL ||
      !bytes_argument(env, argv[1], &request, &request_length)) {
    napi_throw(env, make_error(env, "EINVAL", "expected named pipe connection and frame"));
    return NULL;
  }
  uint8_t *response = NULL;
  DWORD response_length = 0;
  if (!write_exact(connection->handle, request, (DWORD)request_length) ||
      !read_frame(connection->handle, &response, &response_length)) {
    close_connection(connection);
    napi_throw(env, make_error(env, "EPIPEEXCHANGE", "named pipe request failed"));
    return NULL;
  }
  close_connection(connection);
  napi_value result;
  napi_create_buffer_copy(env, response_length, response, NULL, &result);
  vault_secure_clear(response, response_length);
  free(response);
  return result;
}

static napi_value verify_authenticode(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  wchar_t *path = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      !string_argument(env, argv[0], &path)) {
    napi_throw(env, make_error(env, "EINVAL", "expected executable path"));
    return NULL;
  }

  WINTRUST_FILE_INFO file_info = {
      .cbStruct = sizeof(file_info),
      .pcwszFilePath = path,
  };
  WINTRUST_DATA trust_data = {
      .cbStruct = sizeof(trust_data),
      .dwUIChoice = WTD_UI_NONE,
      .fdwRevocationChecks = WTD_REVOKE_NONE,
      .dwUnionChoice = WTD_CHOICE_FILE,
      .pFile = &file_info,
      .dwStateAction = WTD_STATEACTION_VERIFY,
      .dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL,
  };
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG trust_status = WinVerifyTrust(INVALID_HANDLE_VALUE, &action, &trust_data);
  trust_data.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(INVALID_HANDLE_VALUE, &action, &trust_data);
  if (trust_status != ERROR_SUCCESS) {
    free(path);
    napi_throw(env, make_error(env, "EAUTHENTICODE", "Authenticode verification failed"));
    return NULL;
  }

  HCERTSTORE store = NULL;
  HCRYPTMSG message = NULL;
  DWORD encoding = 0;
  DWORD content_type = 0;
  DWORD format_type = 0;
  if (!CryptQueryObject(
          CERT_QUERY_OBJECT_FILE,
          path,
          CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
          CERT_QUERY_FORMAT_FLAG_BINARY,
          0,
          &encoding,
          &content_type,
          &format_type,
          &store,
          &message,
          NULL)) {
    free(path);
    napi_throw(env, make_error(env, "EAUTHENTICODE", "Authenticode signer is unavailable"));
    return NULL;
  }
  free(path);

  DWORD signer_size = 0;
  CMSG_SIGNER_INFO *signer = NULL;
  PCCERT_CONTEXT certificate = NULL;
  wchar_t publisher[512];
  uint8_t thumbprint[32];
  DWORD thumbprint_length = sizeof(thumbprint);
  int success =
      CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, NULL, &signer_size) &&
      signer_size > 0;
  if (success) {
    signer = malloc(signer_size);
    success = signer != NULL &&
              CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, signer, &signer_size);
  }
  if (success) {
    CERT_INFO certificate_info = {
        .Issuer = signer->Issuer,
        .SerialNumber = signer->SerialNumber,
    };
    certificate = CertFindCertificateInStore(
        store,
        encoding,
        0,
        CERT_FIND_SUBJECT_CERT,
        &certificate_info,
        NULL);
    success = certificate != NULL;
  }
  if (success) {
    success =
        CertGetNameStringW(
            certificate,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            NULL,
            publisher,
            sizeof(publisher) / sizeof(publisher[0])) > 1 &&
        CryptHashCertificate2(
            BCRYPT_SHA256_ALGORITHM,
            0,
            NULL,
            certificate->pbCertEncoded,
            certificate->cbCertEncoded,
            thumbprint,
            &thumbprint_length) &&
        thumbprint_length == sizeof(thumbprint);
  }
  if (!success) {
    if (certificate != NULL) CertFreeCertificateContext(certificate);
    free(signer);
    CryptMsgClose(message);
    CertCloseStore(store, 0);
    napi_throw(env, make_error(env, "EAUTHENTICODE", "Authenticode signer is unavailable"));
    return NULL;
  }

  char thumbprint_hex[sizeof(thumbprint) * 2 + 1];
  static const char hex[] = "0123456789abcdef";
  for (size_t index = 0; index < sizeof(thumbprint); index++) {
    thumbprint_hex[index * 2] = hex[thumbprint[index] >> 4];
    thumbprint_hex[index * 2 + 1] = hex[thumbprint[index] & 0x0f];
  }
  thumbprint_hex[sizeof(thumbprint) * 2] = '\0';
  napi_value publisher_value;
  napi_value result;
  napi_value thumbprint_value;
  napi_create_object(env, &result);
  napi_create_string_utf16(env, (const char16_t *)publisher, NAPI_AUTO_LENGTH, &publisher_value);
  napi_create_string_utf8(env, thumbprint_hex, NAPI_AUTO_LENGTH, &thumbprint_value);
  napi_set_named_property(env, result, "publisher", publisher_value);
  napi_set_named_property(env, result, "thumbprint", thumbprint_value);
  vault_secure_clear(thumbprint, sizeof(thumbprint));
  CertFreeCertificateContext(certificate);
  free(signer);
  CryptMsgClose(message);
  CertCloseStore(store, 0);
  return result;
}

static napi_value peer_info(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t file_descriptor = -1;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &file_descriptor) != napi_ok || file_descriptor < 0) {
    napi_throw(env, make_error(env, "EINVAL", "expected named pipe file descriptor"));
    return NULL;
  }

  const uv_os_fd_t handle_value = uv_get_osfhandle(file_descriptor);
  if (handle_value == INVALID_HANDLE_VALUE) {
    napi_throw(env, make_error(env, "EINVAL", "named pipe handle is unavailable"));
    return NULL;
  }
  ULONG pid = 0;
  if (!peer_process_id(handle_value, &pid)) {
    napi_throw(env, make_error(env, "EPEERPID", "named pipe peer process is unavailable"));
    return NULL;
  }
  wchar_t *path = NULL;
  wchar_t *sid = NULL;
  DWORD path_length = 0;
  if (!pipe_peer_identity(handle_value, 0, &pid, &path, &path_length, &sid)) {
    free(path);
    free(sid);
    napi_throw(env, make_error(env, "EPEERIDENTITY", "named pipe peer identity is unavailable"));
    return NULL;
  }
  napi_value result = peer_identity_value(env, pid, path, path_length, sid);
  free(path);
  free(sid);
  return result;
}

static napi_value run_service_dispatcher(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0 ||
      !initialize_service_events()) {
    napi_throw(env, make_error(env, "ESERVICE", "Windows service initialization failed"));
    return NULL;
  }
  ResetEvent(service_ready_event);
  ResetEvent(service_stopped_event);
  InterlockedExchange(&service_stop_requested, 0);
  InterlockedExchange(&service_lock_requested, 0);
  SERVICE_TABLE_ENTRYW table[] = {
      {L"InFlowVault", vault_service_main},
      {NULL, NULL},
  };
  if (!StartServiceCtrlDispatcherW(table)) {
    napi_throw(env, make_error(env, "ESERVICE", "Windows service dispatcher failed"));
    return NULL;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value mark_service_ready(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0 ||
      !initialize_service_events() || !SetEvent(service_ready_event)) {
    napi_throw(env, make_error(env, "ESERVICE", "Windows service readiness failed"));
    return NULL;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value service_control_state(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0) {
    napi_throw(env, make_error(env, "EINVAL", "expected no arguments"));
    return NULL;
  }
  napi_value lock_requested;
  napi_value result;
  napi_value stop_requested;
  napi_create_object(env, &result);
  napi_get_boolean(env, InterlockedExchange(&service_lock_requested, 0) != 0, &lock_requested);
  napi_get_boolean(env, InterlockedCompareExchange(&service_stop_requested, 0, 0) != 0, &stop_requested);
  napi_set_named_property(env, result, "lockRequested", lock_requested);
  napi_set_named_property(env, result, "stopRequested", stop_requested);
  return result;
}

static napi_value complete_service_stop(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0 ||
      !initialize_service_events() || !SetEvent(service_stopped_event)) {
    napi_throw(env, make_error(env, "ESERVICE", "Windows service shutdown failed"));
    return NULL;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value accept_pipe_connection_function;
  napi_value begin_pipe_session_function;
  napi_value close_pipe_connection_function;
  napi_value connect_pipe_function;
  napi_value complete_service_stop_function;
  napi_value exchange_pipe_request_function;
  napi_value mark_service_ready_function;
  napi_value peer_info_function;
  napi_value read_pipe_request_function;
  napi_value run_service_dispatcher_function;
  napi_value service_control_state_function;
  napi_value verify_authenticode_function;
  napi_value write_pipe_response_function;
  napi_create_function(
      env,
      "acceptPipeConnection",
      NAPI_AUTO_LENGTH,
      accept_pipe_connection,
      NULL,
      &accept_pipe_connection_function);
  napi_create_function(
      env,
      "beginPipeSession",
      NAPI_AUTO_LENGTH,
      begin_pipe_session,
      NULL,
      &begin_pipe_session_function);
  napi_create_function(
      env,
      "closePipeConnection",
      NAPI_AUTO_LENGTH,
      close_pipe_connection,
      NULL,
      &close_pipe_connection_function);
  napi_create_function(env, "connectPipe", NAPI_AUTO_LENGTH, connect_pipe, NULL, &connect_pipe_function);
  napi_create_function(
      env,
      "completeServiceStop",
      NAPI_AUTO_LENGTH,
      complete_service_stop,
      NULL,
      &complete_service_stop_function);
  napi_create_function(
      env,
      "exchangePipeRequest",
      NAPI_AUTO_LENGTH,
      exchange_pipe_request,
      NULL,
      &exchange_pipe_request_function);
  napi_create_function(env, "peerInfo", NAPI_AUTO_LENGTH, peer_info, NULL, &peer_info_function);
  napi_create_function(
      env,
      "readPipeRequest",
      NAPI_AUTO_LENGTH,
      read_pipe_request,
      NULL,
      &read_pipe_request_function);
  napi_create_function(
      env,
      "runServiceDispatcher",
      NAPI_AUTO_LENGTH,
      run_service_dispatcher,
      NULL,
      &run_service_dispatcher_function);
  napi_create_function(
      env,
      "markServiceReady",
      NAPI_AUTO_LENGTH,
      mark_service_ready,
      NULL,
      &mark_service_ready_function);
  napi_create_function(
      env,
      "serviceControlState",
      NAPI_AUTO_LENGTH,
      service_control_state,
      NULL,
      &service_control_state_function);
  napi_create_function(
      env,
      "writePipeResponse",
      NAPI_AUTO_LENGTH,
      write_pipe_response,
      NULL,
      &write_pipe_response_function);
  napi_create_function(
      env,
      "verifyAuthenticode",
      NAPI_AUTO_LENGTH,
      verify_authenticode,
      NULL,
      &verify_authenticode_function);
  napi_set_named_property(env, exports, "acceptPipeConnection", accept_pipe_connection_function);
  napi_set_named_property(env, exports, "beginPipeSession", begin_pipe_session_function);
  napi_set_named_property(env, exports, "closePipeConnection", close_pipe_connection_function);
  napi_set_named_property(env, exports, "connectPipe", connect_pipe_function);
  napi_set_named_property(env, exports, "completeServiceStop", complete_service_stop_function);
  napi_set_named_property(env, exports, "exchangePipeRequest", exchange_pipe_request_function);
  napi_set_named_property(env, exports, "peerInfo", peer_info_function);
  napi_set_named_property(env, exports, "readPipeRequest", read_pipe_request_function);
  napi_set_named_property(env, exports, "runServiceDispatcher", run_service_dispatcher_function);
  napi_set_named_property(env, exports, "markServiceReady", mark_service_ready_function);
  napi_set_named_property(env, exports, "serviceControlState", service_control_state_function);
  napi_set_named_property(env, exports, "verifyAuthenticode", verify_authenticode_function);
  napi_set_named_property(env, exports, "writePipeResponse", write_pipe_response_function);
  if (register_vault_secure_memory(env, exports) != napi_ok) {
    return NULL;
  }
  if (register_vault_crypto_native(env, exports) != napi_ok) {
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
