#ifndef INFLOW_VAULT_PIPE_IO_WINDOWS_H
#define INFLOW_VAULT_PIPE_IO_WINDOWS_H

#include <stdint.h>
#include <windows.h>

static int vault_pipe_transfer(
    HANDLE pipe,
    uint8_t *buffer,
    DWORD length,
    int writing,
    ULONGLONG deadline) {
  HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (event == NULL) return 0;
  DWORD offset = 0;
  DWORD failure = ERROR_SUCCESS;
  while (offset < length) {
    const ULONGLONG now = GetTickCount64();
    if (now >= deadline) {
      failure = ERROR_TIMEOUT;
      break;
    }
    OVERLAPPED operation = {0};
    operation.hEvent = event;
    ResetEvent(event);
    DWORD transferred = 0;
    const BOOL completed = writing
        ? WriteFile(pipe, buffer + offset, length - offset, &transferred, &operation)
        : ReadFile(pipe, buffer + offset, length - offset, &transferred, &operation);
    if (!completed) {
      failure = GetLastError();
      if (failure != ERROR_IO_PENDING) break;
      const ULONGLONG wait_start = GetTickCount64();
      const ULONGLONG remaining = deadline > wait_start ? deadline - wait_start : 0;
      const DWORD waited = WaitForSingleObject(event, (DWORD)(remaining > MAXDWORD - 1 ? MAXDWORD - 1 : remaining));
      if (waited != WAIT_OBJECT_0) {
        failure = waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : (waited == WAIT_FAILED ? GetLastError() : ERROR_GEN_FAILURE);
        CancelIoEx(pipe, &operation);
        /* Cancellation must complete before the stack operation or buffer can be released. */
        GetOverlappedResult(pipe, &operation, &transferred, TRUE);
        break;
      }
      if (!GetOverlappedResult(pipe, &operation, &transferred, FALSE)) {
        failure = GetLastError();
        break;
      }
      failure = ERROR_SUCCESS;
    }
    if (transferred == 0 || transferred > length - offset) {
      failure = ERROR_BROKEN_PIPE;
      break;
    }
    offset += transferred;
  }
  CloseHandle(event);
  if (failure != ERROR_SUCCESS) SetLastError(failure);
  return failure == ERROR_SUCCESS;
}

#endif
