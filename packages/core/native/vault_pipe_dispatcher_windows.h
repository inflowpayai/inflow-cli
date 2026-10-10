#ifndef INFLOW_VAULT_PIPE_DISPATCHER_WINDOWS_H
#define INFLOW_VAULT_PIPE_DISPATCHER_WINDOWS_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
#include <sddl.h>

#define VAULT_PIPE_SLOTS 32
#define VAULT_PIPE_FRAME_LIMIT (4 + 1024 * 1024)
#define VAULT_PIPE_SECURITY L"D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;S-1-5-80-1098611787-2118564361-3861463042-200152011-2924560963)(A;;0x12008b;;;AU)"

typedef enum vault_pipe_stage {
  VAULT_PIPE_CONNECT,
  VAULT_PIPE_HANDSHAKE,
  VAULT_PIPE_AUTHORIZE,
  VAULT_PIPE_HEADER,
  VAULT_PIPE_BODY,
  VAULT_PIPE_RESPONSE,
  VAULT_PIPE_WRITE
} vault_pipe_stage;

typedef enum vault_pipe_event_kind {
  VAULT_PIPE_VERIFY,
  VAULT_PIPE_REQUEST,
  VAULT_PIPE_CLOSED
} vault_pipe_event_kind;

typedef struct vault_pipe_event {
  vault_pipe_event_kind kind;
  DWORD slot;
  DWORD generation;
  DWORD request;
  HANDLE pipe;
  const uint8_t *frame;
  DWORD length;
} vault_pipe_event;

/* Called on the dispatcher thread; frame and pipe are borrowed only for this call. */
typedef int (*vault_pipe_emit)(void *context, const vault_pipe_event *event);

typedef struct vault_pipe_mailbox {
  DWORD generation;
  DWORD request;
  vault_pipe_stage expected;
  int waiting;
  int ready;
  int authorized;
  uint8_t *frame;
  DWORD length;
} vault_pipe_mailbox;

typedef struct vault_pipe_slot {
  HANDLE pipe;
  OVERLAPPED operation;
  int pending;
  DWORD immediate;
  vault_pipe_stage stage;
  DWORD generation;
  DWORD request;
  ULONGLONG deadline;
  uint8_t prefix[8];
  uint8_t *frame;
  DWORD length;
  DWORD offset;
  vault_pipe_mailbox mailbox;
} vault_pipe_slot;

typedef struct vault_pipe_dispatcher {
  vault_pipe_slot slots[VAULT_PIPE_SLOTS];
  HANDLE stop;
  HANDLE wake;
  SRWLOCK lock;
  vault_pipe_emit emit;
  void *context;
  DWORD failure;
} vault_pipe_dispatcher;

static void vault_pipe_wipe_free(uint8_t *frame, DWORD length) {
  if (frame == NULL) return;
  SecureZeroMemory(frame, length);
  free(frame);
}

static void vault_pipe_drain(vault_pipe_slot *slot) {
  if (!slot->pending) return;
  CancelIoEx(slot->pipe, &slot->operation);
  DWORD transferred = 0;
  /* Cancellation can lose to completion; both paths retain the buffer until drained. */
  GetOverlappedResult(slot->pipe, &slot->operation, &transferred, TRUE);
  slot->pending = 0;
}

static void vault_pipe_dispatcher_stop(vault_pipe_dispatcher *dispatcher) {
  SetEvent(dispatcher->stop);
}

/* The run loop and every producer must have stopped before destruction. */
static void vault_pipe_dispatcher_destroy(vault_pipe_dispatcher *dispatcher) {
  for (DWORD index = 0; index < VAULT_PIPE_SLOTS; index++) {
    vault_pipe_slot *slot = &dispatcher->slots[index];
    vault_pipe_drain(slot);
    if (slot->pipe != INVALID_HANDLE_VALUE) CloseHandle(slot->pipe);
    if (slot->operation.hEvent != NULL) CloseHandle(slot->operation.hEvent);
    vault_pipe_wipe_free(slot->frame, slot->length);
    vault_pipe_wipe_free(slot->mailbox.frame, slot->mailbox.length);
  }
  if (dispatcher->stop != NULL) CloseHandle(dispatcher->stop);
  if (dispatcher->wake != NULL) CloseHandle(dispatcher->wake);
  free(dispatcher);
}

static int vault_pipe_issue(vault_pipe_slot *slot) {
  HANDLE event = slot->operation.hEvent;
  memset(&slot->operation, 0, sizeof(slot->operation));
  slot->operation.hEvent = event;
  ResetEvent(event);
  slot->immediate = 0;
  BOOL complete;
  if (slot->stage == VAULT_PIPE_CONNECT) {
    complete = ConnectNamedPipe(slot->pipe, &slot->operation);
    if (!complete && GetLastError() == ERROR_PIPE_CONNECTED) complete = TRUE;
  } else {
    uint8_t *bytes = slot->frame == NULL ? slot->prefix : slot->frame;
    if (slot->stage == VAULT_PIPE_WRITE) {
      complete = WriteFile(slot->pipe, bytes + slot->offset, slot->length - slot->offset,
          &slot->immediate, &slot->operation);
    } else {
      complete = ReadFile(slot->pipe, bytes + slot->offset, slot->length - slot->offset,
          &slot->immediate, &slot->operation);
    }
  }
  if (complete) {
    SetEvent(event);
    return 1;
  }
  if (GetLastError() != ERROR_IO_PENDING) return 0;
  slot->pending = 1;
  return 1;
}

static int vault_pipe_notify(vault_pipe_dispatcher *dispatcher, DWORD index, vault_pipe_event_kind kind) {
  vault_pipe_slot *slot = &dispatcher->slots[index];
  vault_pipe_event event = {
      .kind = kind, .slot = index, .generation = slot->generation, .request = slot->request,
      .pipe = slot->pipe, .frame = kind == VAULT_PIPE_REQUEST ? slot->frame : NULL,
      .length = kind == VAULT_PIPE_REQUEST ? slot->length : 0,
  };
  return dispatcher->emit(dispatcher->context, &event);
}

static void vault_pipe_reconnect(vault_pipe_dispatcher *dispatcher, DWORD index) {
  vault_pipe_slot *slot = &dispatcher->slots[index];
  vault_pipe_drain(slot);
  AcquireSRWLockExclusive(&dispatcher->lock);
  vault_pipe_wipe_free(slot->mailbox.frame, slot->mailbox.length);
  memset(&slot->mailbox, 0, sizeof(slot->mailbox));
  ReleaseSRWLockExclusive(&dispatcher->lock);
  if (slot->stage != VAULT_PIPE_CONNECT) vault_pipe_notify(dispatcher, index, VAULT_PIPE_CLOSED);
  vault_pipe_wipe_free(slot->frame, slot->length);
  slot->frame = NULL;
  SecureZeroMemory(slot->prefix, sizeof(slot->prefix));
  slot->length = 0;
  slot->offset = 0;
  slot->request = 0;
  slot->deadline = 0;
  slot->stage = VAULT_PIPE_CONNECT;
  DisconnectNamedPipe(slot->pipe);
  if (slot->generation == MAXDWORD) {
    dispatcher->failure = ERROR_ARITHMETIC_OVERFLOW;
    vault_pipe_dispatcher_stop(dispatcher);
    return;
  }
  slot->generation++;
  if (WaitForSingleObject(dispatcher->stop, 0) != WAIT_OBJECT_0 && !vault_pipe_issue(slot)) {
    dispatcher->failure = GetLastError();
    vault_pipe_dispatcher_stop(dispatcher);
  }
}

static vault_pipe_dispatcher *vault_pipe_dispatcher_create(
    const wchar_t *name, vault_pipe_emit emit, void *context) {
  if (name == NULL || name[0] == L'\0' || emit == NULL) {
    SetLastError(ERROR_INVALID_PARAMETER);
    return NULL;
  }
  vault_pipe_dispatcher *dispatcher = calloc(1, sizeof(*dispatcher));
  if (dispatcher == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  for (DWORD index = 0; index < VAULT_PIPE_SLOTS; index++) dispatcher->slots[index].pipe = INVALID_HANDLE_VALUE;
  InitializeSRWLock(&dispatcher->lock);
  dispatcher->emit = emit;
  dispatcher->context = context;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  dispatcher->stop = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (dispatcher->stop == NULL) goto failure;
  dispatcher->wake = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (dispatcher->wake == NULL) goto failure;
  /* Authenticated users receive FILE_GENERIC_READ | FILE_WRITE_DATA, not FILE_CREATE_PIPE_INSTANCE. */
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          VAULT_PIPE_SECURITY,
          SDDL_REVISION_1, &descriptor, NULL)) goto failure;
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), descriptor, FALSE };
  for (DWORD index = 0; index < VAULT_PIPE_SLOTS; index++) {
    vault_pipe_slot *slot = &dispatcher->slots[index];
    slot->generation = 1;
    slot->stage = VAULT_PIPE_CONNECT;
    slot->pipe = CreateNamedPipeW(name,
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (index == 0 ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        VAULT_PIPE_SLOTS, 4096, 4096, 0, &attributes);
    if (slot->pipe == INVALID_HANDLE_VALUE) goto failure;
    slot->operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (slot->operation.hEvent == NULL || !vault_pipe_issue(slot)) goto failure;
  }
  LocalFree(descriptor);
  return dispatcher;

failure:;
  DWORD error = GetLastError();
  if (descriptor != NULL) LocalFree(descriptor);
  vault_pipe_dispatcher_destroy(dispatcher);
  SetLastError(error);
  return NULL;
}

static void vault_pipe_expect(vault_pipe_dispatcher *dispatcher, DWORD index, vault_pipe_stage stage) {
  vault_pipe_slot *slot = &dispatcher->slots[index];
  slot->stage = stage;
  slot->deadline = GetTickCount64() + 10000;
  ResetEvent(slot->operation.hEvent);
  AcquireSRWLockExclusive(&dispatcher->lock);
  slot->mailbox.generation = slot->generation;
  slot->mailbox.request = slot->request;
  slot->mailbox.expected = stage;
  slot->mailbox.waiting = 1;
  ReleaseSRWLockExclusive(&dispatcher->lock);
}

/* Producers submit one result for an exact connection generation and request sequence. */
static int vault_pipe_submit(vault_pipe_dispatcher *dispatcher, DWORD index, DWORD generation,
    DWORD request, int authorized, const uint8_t *frame, DWORD length) {
  if (index >= VAULT_PIPE_SLOTS) return 0;
  AcquireSRWLockExclusive(&dispatcher->lock);
  vault_pipe_mailbox *mailbox = &dispatcher->slots[index].mailbox;
  int accepted = 0;
  if (WaitForSingleObject(dispatcher->stop, 0) == WAIT_OBJECT_0 || !mailbox->waiting || mailbox->ready ||
      mailbox->generation != generation || mailbox->request != request) goto done;
  if (mailbox->expected == VAULT_PIPE_AUTHORIZE) {
    if (frame != NULL || length != 0) goto done;
    mailbox->authorized = authorized;
  } else {
    if (frame == NULL || length < 5 || length > VAULT_PIPE_FRAME_LIMIT) goto done;
    const DWORD body = ((DWORD)frame[0] << 24) | ((DWORD)frame[1] << 16) | ((DWORD)frame[2] << 8) | frame[3];
    if (body != length - 4) goto done;
    mailbox->frame = malloc(length);
    if (mailbox->frame == NULL) goto done;
    memcpy(mailbox->frame, frame, length);
    mailbox->length = length;
  }
  mailbox->ready = 1;
  SetEvent(dispatcher->wake);
  accepted = 1;
done:
  ReleaseSRWLockExclusive(&dispatcher->lock);
  return accepted;
}

static void vault_pipe_read_header(vault_pipe_slot *slot) {
  slot->stage = VAULT_PIPE_HEADER;
  slot->length = 4;
  slot->offset = 0;
  slot->deadline = GetTickCount64() + 60000;
}

static void vault_pipe_process_mail(vault_pipe_dispatcher *dispatcher) {
  AcquireSRWLockExclusive(&dispatcher->lock);
  ResetEvent(dispatcher->wake);
  ReleaseSRWLockExclusive(&dispatcher->lock);
  for (DWORD index = 0; index < VAULT_PIPE_SLOTS; index++) {
    vault_pipe_slot *slot = &dispatcher->slots[index];
    AcquireSRWLockExclusive(&dispatcher->lock);
    vault_pipe_mailbox mail = slot->mailbox;
    if (mail.ready) memset(&slot->mailbox, 0, sizeof(slot->mailbox));
    ReleaseSRWLockExclusive(&dispatcher->lock);
    if (!mail.ready) continue;
    if (GetTickCount64() >= slot->deadline || WaitForSingleObject(dispatcher->stop, 0) == WAIT_OBJECT_0) {
      vault_pipe_wipe_free(mail.frame, mail.length);
      vault_pipe_reconnect(dispatcher, index);
      continue;
    }
    if (slot->stage == VAULT_PIPE_AUTHORIZE) {
      if (!mail.authorized) {
        vault_pipe_reconnect(dispatcher, index);
        continue;
      }
      vault_pipe_read_header(slot);
    } else {
      slot->frame = mail.frame;
      slot->length = mail.length;
      slot->offset = 0;
      slot->stage = VAULT_PIPE_WRITE;
      slot->deadline = GetTickCount64() + 10000;
    }
    if (!vault_pipe_issue(slot)) vault_pipe_reconnect(dispatcher, index);
  }
}

static void vault_pipe_complete(vault_pipe_dispatcher *dispatcher, DWORD index) {
  vault_pipe_slot *slot = &dispatcher->slots[index];
  DWORD transferred = slot->immediate;
  if (slot->pending) {
    if (!GetOverlappedResult(slot->pipe, &slot->operation, &transferred, FALSE)) {
      vault_pipe_reconnect(dispatcher, index);
      return;
    }
    slot->pending = 0;
  }
  if (slot->stage == VAULT_PIPE_CONNECT) {
    slot->stage = VAULT_PIPE_HANDSHAKE;
    slot->length = 8;
    slot->offset = 0;
    slot->deadline = GetTickCount64() + 10000;
  } else {
    if (transferred == 0 || transferred > slot->length - slot->offset) {
      vault_pipe_reconnect(dispatcher, index);
      return;
    }
    if (slot->stage == VAULT_PIPE_HEADER && slot->offset == 0) slot->deadline = GetTickCount64() + 10000;
    slot->offset += transferred;
    if (slot->offset == slot->length) {
      switch (slot->stage) {
        case VAULT_PIPE_HANDSHAKE:
          if (memcmp(slot->prefix, "INFLOWV1", 8) != 0) {
            vault_pipe_reconnect(dispatcher, index);
            return;
          }
          vault_pipe_expect(dispatcher, index, VAULT_PIPE_AUTHORIZE);
          if (!vault_pipe_notify(dispatcher, index, VAULT_PIPE_VERIFY)) vault_pipe_reconnect(dispatcher, index);
          return;
        case VAULT_PIPE_HEADER: {
          DWORD body = ((DWORD)slot->prefix[0] << 24) | ((DWORD)slot->prefix[1] << 16) |
              ((DWORD)slot->prefix[2] << 8) | slot->prefix[3];
          if (body == 0 || body > VAULT_PIPE_FRAME_LIMIT - 4) {
            vault_pipe_reconnect(dispatcher, index);
            return;
          }
          slot->frame = malloc(body + 4);
          if (slot->frame == NULL) {
            vault_pipe_reconnect(dispatcher, index);
            return;
          }
          memcpy(slot->frame, slot->prefix, 4);
          slot->length = body + 4;
          slot->stage = VAULT_PIPE_BODY;
          break;
        }
        case VAULT_PIPE_BODY: {
          DWORD available = 0;
          if (!PeekNamedPipe(slot->pipe, NULL, 0, NULL, &available, NULL) || available != 0 || slot->request == MAXDWORD) {
            vault_pipe_reconnect(dispatcher, index);
            return;
          }
          slot->request++;
          vault_pipe_expect(dispatcher, index, VAULT_PIPE_RESPONSE);
          const int accepted = vault_pipe_notify(dispatcher, index, VAULT_PIPE_REQUEST);
          vault_pipe_wipe_free(slot->frame, slot->length);
          slot->frame = NULL;
          slot->length = 0;
          if (!accepted) vault_pipe_reconnect(dispatcher, index);
          return;
        }
        case VAULT_PIPE_WRITE:
          vault_pipe_wipe_free(slot->frame, slot->length);
          slot->frame = NULL;
          vault_pipe_read_header(slot);
          break;
        default:
          vault_pipe_reconnect(dispatcher, index);
          return;
      }
    }
  }
  if (!vault_pipe_issue(slot)) vault_pipe_reconnect(dispatcher, index);
}

static DWORD vault_pipe_dispatcher_run(vault_pipe_dispatcher *dispatcher) {
  HANDLE events[VAULT_PIPE_SLOTS + 2] = { dispatcher->stop, dispatcher->wake };
  for (DWORD index = 0; index < VAULT_PIPE_SLOTS; index++) events[index + 2] = dispatcher->slots[index].operation.hEvent;
  for (;;) {
    const DWORD result = WaitForMultipleObjects(VAULT_PIPE_SLOTS + 2, events, FALSE, 100);
    if (result == WAIT_OBJECT_0) break;
    if (result == WAIT_FAILED) {
      dispatcher->failure = GetLastError();
      vault_pipe_dispatcher_stop(dispatcher);
      break;
    }
    if (result == WAIT_OBJECT_0 + 1) vault_pipe_process_mail(dispatcher);
    /* Scan all slots so a continuously ready low-index client cannot starve another. */
    for (DWORD index = 0; index < VAULT_PIPE_SLOTS; index++) {
      if (WaitForSingleObject(dispatcher->stop, 0) == WAIT_OBJECT_0) break;
      vault_pipe_slot *slot = &dispatcher->slots[index];
      if (slot->deadline != 0 && GetTickCount64() >= slot->deadline) {
        vault_pipe_reconnect(dispatcher, index);
      } else if (WaitForSingleObject(slot->operation.hEvent, 0) == WAIT_OBJECT_0) {
        vault_pipe_complete(dispatcher, index);
      }
    }
  }
  for (DWORD index = 0; index < VAULT_PIPE_SLOTS; index++) vault_pipe_reconnect(dispatcher, index);
  return dispatcher->failure;
}

#endif
