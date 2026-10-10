#define WIN32_LEAN_AND_MEAN
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../native/vault_pipe_io_windows.h"

#define CHECK(value) do { if (!(value)) { fprintf(stderr, "failed at line %d, error %lu\n", __LINE__, GetLastError()); exit(1); } } while (0)

typedef struct fixture {
  HANDLE server;
  HANDLE client;
} fixture;

static fixture open_fixture(void) {
  static unsigned int sequence = 0;
  wchar_t name[128];
  swprintf_s(name, 128, L"\\\\.\\pipe\\InFlowIoTest-%lu-%u", GetCurrentProcessId(), ++sequence);
  fixture value;
  value.server = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 64, 64, 0, NULL);
  CHECK(value.server != INVALID_HANDLE_VALUE);
  value.client = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
  CHECK(value.client != INVALID_HANDLE_VALUE);
  CHECK(ConnectNamedPipe(value.server, NULL) || GetLastError() == ERROR_PIPE_CONNECTED);
  return value;
}

static void close_fixture(fixture value) {
  CloseHandle(value.client);
  if (value.server != INVALID_HANDLE_VALUE) CloseHandle(value.server);
}

typedef struct writer {
  HANDLE pipe;
  DWORD delay;
} writer;

static DWORD WINAPI write_parts(LPVOID argument) {
  writer *context = argument;
  for (uint8_t byte = 1; byte <= 4; byte++) {
    Sleep(context->delay);
    DWORD written;
    if (!WriteFile(context->pipe, &byte, 1, &written, NULL) || written != 1) return 1;
  }
  return 0;
}

static void partial_read(DWORD delay, DWORD allowance, int expected) {
  fixture value = open_fixture();
  writer context = { value.server, delay };
  HANDLE thread = CreateThread(NULL, 0, write_parts, &context, 0, NULL);
  CHECK(thread != NULL);
  uint8_t bytes[4] = {0};
  CHECK(vault_pipe_transfer(value.client, bytes, sizeof(bytes), 0, GetTickCount64() + allowance) == expected);
  if (expected) CHECK(memcmp(bytes, "\1\2\3\4", 4) == 0);
  else CHECK(GetLastError() == ERROR_TIMEOUT);
  CHECK(WaitForSingleObject(thread, 2000) == WAIT_OBJECT_0);
  CloseHandle(thread);
  close_fixture(value);
}

int main(void) {
  DWORD handles_before;
  CHECK(GetProcessHandleCount(GetCurrentProcess(), &handles_before));
  fixture value = open_fixture();
  uint8_t bytes[4] = {0};
  ULONGLONG start = GetTickCount64();
  CHECK(!vault_pipe_transfer(value.client, bytes, 4, 0, start + 100));
  CHECK(GetLastError() == ERROR_TIMEOUT);
  CHECK(GetTickCount64() - start < 2000);
  CHECK(!vault_pipe_transfer(value.client, bytes, 4, 0, GetTickCount64()));
  CHECK(GetLastError() == ERROR_TIMEOUT);
  CHECK(vault_pipe_transfer(value.client, bytes, 4, 1, GetTickCount64() + 1000));
  DWORD received;
  CHECK(ReadFile(value.server, bytes, 4, &received, NULL) && received == 4);
  uint8_t *large = calloc(1024 * 1024, 1);
  CHECK(large != NULL);
  start = GetTickCount64();
  CHECK(!vault_pipe_transfer(value.client, large, 1024 * 1024, 1, GetTickCount64() + 100));
  CHECK(GetLastError() == ERROR_TIMEOUT);
  CHECK(GetTickCount64() - start < 2000);
  free(large);
  close_fixture(value);
  partial_read(10, 1000, 1);
  partial_read(80, 150, 0);
  value = open_fixture();
  CloseHandle(value.server);
  value.server = INVALID_HANDLE_VALUE;
  CHECK(!vault_pipe_transfer(value.client, bytes, 4, 0, GetTickCount64() + 1000));
  close_fixture(value);
  for (unsigned int index = 0; index < 100; index++) {
    value = open_fixture();
    CHECK(!vault_pipe_transfer(value.client, bytes, 4, 0, GetTickCount64() + 1));
    CHECK(GetLastError() == ERROR_TIMEOUT);
    close_fixture(value);
  }
  for (unsigned int index = 0; index < 100; index++) {
    value = open_fixture();
    writer context = { value.server, 0 };
    HANDLE thread = CreateThread(NULL, 0, write_parts, &context, 0, NULL);
    CHECK(thread != NULL);
    const int complete = vault_pipe_transfer(value.client, bytes, 4, 0, GetTickCount64() + 1);
    if (complete) CHECK(memcmp(bytes, "\1\2\3\4", 4) == 0);
    else CHECK(GetLastError() == ERROR_TIMEOUT);
    CHECK(WaitForSingleObject(thread, 2000) == WAIT_OBJECT_0);
    CloseHandle(thread);
    close_fixture(value);
  }
  DWORD handles_after;
  CHECK(GetProcessHandleCount(GetCurrentProcess(), &handles_after));
  CHECK(handles_after == handles_before);
  puts("PASS: real Windows pipe deadlines, fragmented reads, blocked writes, disconnects, and handle cleanup");
  return 0;
}
