#define WIN32_LEAN_AND_MEAN
#include <stdio.h>
#include <wchar.h>
#include "../../native/vault_pipe_dispatcher_windows.h"
#include "../../native/vault_pipe_io_windows.h"

#define CHECK(value) do { if (!(value)) { fprintf(stderr, "failed at line %d, error %lu\n", __LINE__, GetLastError()); exit(1); } } while (0)

typedef struct fixture {
  vault_pipe_dispatcher *dispatcher;
  HANDLE thread;
  HANDLE changed;
  wchar_t name[128];
  SRWLOCK lock;
  LONG verifies;
  LONG requests;
  LONG closed;
  int authorize;
  int echo;
  vault_pipe_event last_verify;
  vault_pipe_event last_request;
} fixture;

static int receive_event(void *context, const vault_pipe_event *event) {
  fixture *value = context;
  AcquireSRWLockExclusive(&value->lock);
  if (event->kind == VAULT_PIPE_VERIFY) {
    value->verifies++;
    value->last_verify = *event;
    if (value->authorize != 0) {
      CHECK(vault_pipe_submit(value->dispatcher, event->slot, event->generation, 0, value->authorize > 0, NULL, 0));
    }
  } else if (event->kind == VAULT_PIPE_REQUEST) {
    value->requests++;
    value->last_request = *event;
    value->last_request.frame = NULL;
    if (value->echo) {
      CHECK(vault_pipe_submit(value->dispatcher, event->slot, event->generation, event->request, 0, event->frame, event->length));
    }
  } else {
    value->closed++;
  }
  SetEvent(value->changed);
  ReleaseSRWLockExclusive(&value->lock);
  return 1;
}

static DWORD WINAPI run_dispatcher(LPVOID context) {
  fixture *value = context;
  return vault_pipe_dispatcher_run(value->dispatcher);
}

static void start_fixture(fixture *value, int authorize, int echo) {
  static unsigned int sequence = 0;
  memset(value, 0, sizeof(*value));
  InitializeSRWLock(&value->lock);
  value->authorize = authorize;
  value->echo = echo;
  swprintf_s(value->name, 128, L"\\\\.\\pipe\\InFlowDispatcherTest-%lu-%u", GetCurrentProcessId(), ++sequence);
  value->changed = CreateEventW(NULL, TRUE, FALSE, NULL);
  CHECK(value->changed != NULL);
  value->dispatcher = vault_pipe_dispatcher_create(value->name, receive_event, value);
  CHECK(value->dispatcher != NULL);
  value->thread = CreateThread(NULL, 0, run_dispatcher, value, 0, NULL);
  CHECK(value->thread != NULL);
}

static void stop_fixture(fixture *value) {
  ULONGLONG start = GetTickCount64();
  vault_pipe_dispatcher_stop(value->dispatcher);
  CHECK(WaitForSingleObject(value->thread, 2000) == WAIT_OBJECT_0);
  CHECK(GetTickCount64() - start < 2000);
  DWORD result;
  CHECK(GetExitCodeThread(value->thread, &result) && result == 0);
  CloseHandle(value->thread);
  vault_pipe_dispatcher_destroy(value->dispatcher);
  CloseHandle(value->changed);
}

static HANDLE connect_client(fixture *value) {
  CHECK(WaitNamedPipeW(value->name, 2000));
  HANDLE client = CreateFileW(value->name, GENERIC_READ | FILE_WRITE_DATA, 0, NULL, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
  CHECK(client != INVALID_HANDLE_VALUE);
  return client;
}

static void send_bytes(HANDLE client, const uint8_t *bytes, DWORD length) {
  CHECK(vault_pipe_transfer(client, (uint8_t *)bytes, length, 1, GetTickCount64() + 2000));
}

static void handshake(HANDLE client) {
  send_bytes(client, (const uint8_t *)"INFLOWV1", 8);
}

static vault_pipe_event await_count(fixture *value, vault_pipe_event_kind kind, LONG count, DWORD timeout) {
  const ULONGLONG deadline = GetTickCount64() + timeout;
  for (;;) {
    AcquireSRWLockShared(&value->lock);
    LONG observed = kind == VAULT_PIPE_VERIFY ? value->verifies : kind == VAULT_PIPE_REQUEST ? value->requests : value->closed;
    vault_pipe_event event = kind == VAULT_PIPE_VERIFY ? value->last_verify : value->last_request;
    ResetEvent(value->changed);
    ReleaseSRWLockShared(&value->lock);
    if (observed >= count) return event;
    CHECK(GetTickCount64() < deadline);
    WaitForSingleObject(value->changed, 20);
  }
}

static void expect_echo(HANDLE client) {
  const uint8_t request[] = { 0, 0, 0, 3, 1, 2, 3 };
  uint8_t response[sizeof(request)] = {0};
  send_bytes(client, request, sizeof(request));
  CHECK(vault_pipe_transfer(client, response, sizeof(response), 0, GetTickCount64() + 2000));
  CHECK(memcmp(response, request, sizeof(request)) == 0);
}

static void concurrency_and_ownership(void) {
  fixture value;
  start_fixture(&value, 1, 1);
  HANDLE first_handle = value.dispatcher->slots[0].pipe;
  HANDLE idle = connect_client(&value);
  HANDLE active = connect_client(&value);
  handshake(active);
  for (int index = 0; index < 10; index++) expect_echo(active);
  await_count(&value, VAULT_PIPE_REQUEST, 10, 2000);
  CHECK(value.verifies == 1);
  HANDLE competing = CreateNamedPipeW(value.name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_WAIT, VAULT_PIPE_SLOTS, 64, 64, 0, NULL);
  CHECK(competing == INVALID_HANDLE_VALUE);
  CHECK(GetLastError() == ERROR_ACCESS_DENIED || GetLastError() == ERROR_PIPE_BUSY);
  CHECK(vault_pipe_dispatcher_create(value.name, receive_event, &value) == NULL);
  CHECK(GetLastError() == ERROR_ACCESS_DENIED || GetLastError() == ERROR_PIPE_BUSY);
  CloseHandle(idle);
  CloseHandle(active);
  await_count(&value, VAULT_PIPE_CLOSED, 2, 2000);
  CHECK(value.dispatcher->slots[0].pipe == first_handle);
  active = connect_client(&value);
  handshake(active);
  expect_echo(active);
  CloseHandle(active);
  stop_fixture(&value);
}

static void authentication_gate(void) {
  fixture value;
  start_fixture(&value, 0, 1);
  HANDLE client = connect_client(&value);
  handshake(client);
  vault_pipe_event verify = await_count(&value, VAULT_PIPE_VERIFY, 1, 2000);
  const uint8_t request[] = { 0, 0, 0, 1, 42 };
  send_bytes(client, request, sizeof(request));
  Sleep(100);
  AcquireSRWLockShared(&value.lock);
  CHECK(value.requests == 0);
  ReleaseSRWLockShared(&value.lock);
  CHECK(vault_pipe_submit(value.dispatcher, verify.slot, verify.generation, 0, 0, NULL, 0));
  await_count(&value, VAULT_PIPE_CLOSED, 1, 2000);
  CHECK(value.requests == 0);
  CloseHandle(client);
  client = connect_client(&value);
  handshake(client);
  verify = await_count(&value, VAULT_PIPE_VERIFY, 2, 2000);
  CHECK(vault_pipe_submit(value.dispatcher, verify.slot, verify.generation, 0, 1, NULL, 0));
  expect_echo(client);
  CloseHandle(client);
  stop_fixture(&value);
}

static void framing_and_stale_results(void) {
  fixture value;
  start_fixture(&value, 1, 0);
  HANDLE clients[VAULT_PIPE_SLOTS];
  for (DWORD index = 0; index < VAULT_PIPE_SLOTS; index++) {
    clients[index] = connect_client(&value);
    handshake(clients[index]);
    await_count(&value, VAULT_PIPE_VERIFY, (LONG)index + 1, 2000);
  }
  HANDLE excess = CreateFileW(value.name, GENERIC_READ | FILE_WRITE_DATA, 0, NULL, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED, NULL);
  CHECK(excess == INVALID_HANDLE_VALUE && GetLastError() == ERROR_PIPE_BUSY);
  const uint8_t request[] = { 0, 0, 0, 1, 42 };
  for (DWORD index = 0; index < sizeof(request); index++) send_bytes(clients[0], request + index, 1);
  vault_pipe_event old = await_count(&value, VAULT_PIPE_REQUEST, 1, 2000);
  CHECK(!vault_pipe_submit(value.dispatcher, old.slot, old.generation + 1, old.request, 0, request, sizeof(request)));
  CHECK(!vault_pipe_submit(value.dispatcher, old.slot, old.generation, old.request + 1, 0, request, sizeof(request)));
  const uint8_t invalid[] = {0, 0, 0, 2, 42};
  CHECK(!vault_pipe_submit(value.dispatcher, old.slot, old.generation, old.request, 0, invalid, sizeof(invalid)));
  CHECK(vault_pipe_submit(value.dispatcher, old.slot, old.generation, old.request, 0, request, sizeof(request)));
  uint8_t response[sizeof(request)];
  CHECK(vault_pipe_transfer(clients[0], response, sizeof(response), 0, GetTickCount64() + 2000));
  CHECK(memcmp(response, request, sizeof(request)) == 0);
  send_bytes(clients[0], request, sizeof(request));
  vault_pipe_event second = await_count(&value, VAULT_PIPE_REQUEST, 2, 2000);
  CHECK(second.generation == old.generation && second.request != old.request);
  CHECK(!vault_pipe_submit(value.dispatcher, old.slot, old.generation, old.request, 0, request, sizeof(request)));
  CloseHandle(clients[0]);
  await_count(&value, VAULT_PIPE_CLOSED, 1, 12000);
  clients[0] = connect_client(&value);
  handshake(clients[0]);
  vault_pipe_event replacement = await_count(&value, VAULT_PIPE_VERIFY, VAULT_PIPE_SLOTS + 1, 2000);
  CHECK(replacement.slot == old.slot && replacement.generation != old.generation);
  send_bytes(clients[0], request, sizeof(request));
  replacement = await_count(&value, VAULT_PIPE_REQUEST, 3, 2000);
  CHECK(!vault_pipe_submit(value.dispatcher, old.slot, old.generation, second.request, 0, request, sizeof(request)));
  CHECK(vault_pipe_submit(value.dispatcher, replacement.slot, replacement.generation, replacement.request, 0, request, sizeof(request)));
  CHECK(vault_pipe_transfer(clients[0], response, sizeof(response), 0, GetTickCount64() + 2000));
  for (DWORD index = 0; index < VAULT_PIPE_SLOTS; index++) CloseHandle(clients[index]);
  stop_fixture(&value);
}

static void malformed_frames_and_timeout(void) {
  fixture value;
  start_fixture(&value, 1, 1);
  HANDLE stalled = connect_client(&value);
  HANDLE bad = connect_client(&value);
  send_bytes(bad, (const uint8_t *)"BADHELLO", 8);
  await_count(&value, VAULT_PIPE_CLOSED, 1, 2000);
  CloseHandle(bad);
  const uint8_t invalid[][4] = {{0, 0, 0, 0}, {0, 16, 0, 1}, {255, 255, 255, 255}};
  for (int index = 0; index < 3; index++) {
    bad = connect_client(&value);
    handshake(bad);
    send_bytes(bad, invalid[index], 4);
    await_count(&value, VAULT_PIPE_CLOSED, index + 2, 2000);
    CloseHandle(bad);
  }
  bad = connect_client(&value);
  handshake(bad);
  const uint8_t pipelined[] = {0, 0, 0, 1, 42, 0, 0, 0, 1, 43};
  send_bytes(bad, pipelined, sizeof(pipelined));
  await_count(&value, VAULT_PIPE_CLOSED, 5, 2000);
  CloseHandle(bad);
  await_count(&value, VAULT_PIPE_CLOSED, 6, 12000);
  CHECK(value.requests == 0);
  CloseHandle(stalled);
  stop_fixture(&value);
}

static void stop_pending_operations(void) {
  fixture value;
  start_fixture(&value, 1, 0);
  HANDLE idle = connect_client(&value);
  HANDLE partial = connect_client(&value);
  handshake(partial);
  const uint8_t fragment[] = {0, 0, 0, 8, 42};
  send_bytes(partial, fragment, sizeof(fragment));
  HANDLE blocked = connect_client(&value);
  handshake(blocked);
  const uint8_t request[] = {0, 0, 0, 1, 42};
  send_bytes(blocked, request, sizeof(request));
  vault_pipe_event event = await_count(&value, VAULT_PIPE_REQUEST, 1, 2000);
  uint8_t *response = calloc(VAULT_PIPE_FRAME_LIMIT, 1);
  CHECK(response != NULL);
  response[1] = 16;
  CHECK(vault_pipe_submit(value.dispatcher, event.slot, event.generation, event.request, 0, response, VAULT_PIPE_FRAME_LIMIT));
  free(response);
  DWORD available = 0;
  const ULONGLONG deadline = GetTickCount64() + 2000;
  while (available == 0) {
    CHECK(PeekNamedPipe(blocked, NULL, 0, NULL, &available, NULL));
    CHECK(GetTickCount64() < deadline);
    if (available == 0) Sleep(1);
  }
  stop_fixture(&value);
  CloseHandle(idle);
  CloseHandle(partial);
  CloseHandle(blocked);
}

static void restricted_client_permissions(void) {
  wchar_t name[128];
  swprintf_s(name, 128, L"\\\\.\\pipe\\InFlowDispatcherAclTest-%lu", GetCurrentProcessId());
  PSECURITY_DESCRIPTOR descriptor = NULL;
  CHECK(ConvertStringSecurityDescriptorToSecurityDescriptorW(VAULT_PIPE_SECURITY, SDDL_REVISION_1, &descriptor, NULL));
  SECURITY_ATTRIBUTES attributes = {sizeof(attributes), descriptor, FALSE};
  HANDLE server = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, VAULT_PIPE_SLOTS, 4096, 4096, 0, &attributes);
  LocalFree(descriptor);
  CHECK(server != INVALID_HANDLE_VALUE);
  BYTE sid_bytes[SECURITY_MAX_SID_SIZE];
  DWORD sid_length = sizeof(sid_bytes);
  CHECK(CreateWellKnownSid(WinAuthenticatedUserSid, NULL, sid_bytes, &sid_length));
  SID_AND_ATTRIBUTES restricted_sid = {sid_bytes, 0};
  HANDLE current = NULL;
  HANDLE restricted = NULL;
  CHECK(OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY, &current));
  CHECK(CreateRestrictedToken(current, DISABLE_MAX_PRIVILEGE, 0, NULL, 0, NULL, 1, &restricted_sid, &restricted));
  CloseHandle(current);
  CHECK(ImpersonateLoggedOnUser(restricted));
  HANDLE client = CreateFileW(name, GENERIC_READ | FILE_WRITE_DATA, 0, NULL, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
  DWORD client_error = GetLastError();
  HANDLE competing = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, VAULT_PIPE_SLOTS, 4096, 4096, 0, NULL);
  DWORD competing_error = GetLastError();
  CHECK(RevertToSelf());
  CloseHandle(restricted);
  SetLastError(client_error);
  CHECK(client != INVALID_HANDLE_VALUE);
  SetLastError(competing_error);
  CHECK(competing == INVALID_HANDLE_VALUE && competing_error == ERROR_ACCESS_DENIED);
  CHECK(ConnectNamedPipe(server, NULL) || GetLastError() == ERROR_PIPE_CONNECTED);
  const uint8_t value = 42;
  send_bytes(client, &value, 1);
  uint8_t received = 0;
  DWORD transferred = 0;
  CHECK(ReadFile(server, &received, 1, &transferred, NULL) && transferred == 1 && received == value);
  CHECK(WriteFile(server, &value, 1, &transferred, NULL) && transferred == 1);
  CHECK(vault_pipe_transfer(client, &received, 1, 0, GetTickCount64() + 2000) && received == value);
  CloseHandle(client);
  CloseHandle(server);
}

int main(void) {
  DWORD before;
  /* Windows security-descriptor initialization owns process-lifetime handles. */
  PSECURITY_DESCRIPTOR descriptor = NULL;
  CHECK(ConvertStringSecurityDescriptorToSecurityDescriptorW(VAULT_PIPE_SECURITY, SDDL_REVISION_1, &descriptor, NULL));
  LocalFree(descriptor);
  CHECK(GetProcessHandleCount(GetCurrentProcess(), &before));
  CHECK(vault_pipe_dispatcher_create(NULL, receive_event, NULL) == NULL && GetLastError() == ERROR_INVALID_PARAMETER);
  concurrency_and_ownership();
  concurrency_and_ownership();
  authentication_gate();
  framing_and_stale_results();
  malformed_frames_and_timeout();
  stop_pending_operations();
  restricted_client_permissions();
  DWORD after;
  CHECK(GetProcessHandleCount(GetCurrentProcess(), &after));
  CHECK(before == after);
  puts("PASS: Windows concurrent pipe framing, verification gate, deadlines, generations, ownership, bounded admission, cancellation, and handle cleanup");
  return 0;
}
