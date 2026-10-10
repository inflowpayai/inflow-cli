#ifndef INFLOW_VAULT_PIPE_ADAPTER_WINDOWS_H
#define INFLOW_VAULT_PIPE_ADAPTER_WINDOWS_H

#include "vault_pipe_dispatcher_windows.h"

typedef struct vault_pipe_adapter {
  vault_pipe_dispatcher *dispatcher;
  HANDLE thread;
  napi_threadsafe_function callback;
  volatile LONG references;
  volatile LONG queued_bytes;
  volatile LONG failure;
  int callback_closing;
  int cleanup_registered;
} vault_pipe_adapter;

typedef struct vault_pipe_delivery {
  vault_pipe_event_kind kind;
  DWORD slot;
  DWORD generation;
  DWORD sequence;
  ULONG pid;
  wchar_t *path;
  DWORD path_length;
  wchar_t *sid;
  uint8_t *frame;
  DWORD length;
} vault_pipe_delivery;

static void vault_adapter_release(vault_pipe_adapter *adapter) {
  if (InterlockedDecrement(&adapter->references) == 0) free(adapter);
}

/* Only the owning JavaScript thread stops/joins and destroys the native owner. */
static void vault_adapter_stop(vault_pipe_adapter *adapter) {
  if (adapter->dispatcher == NULL) return;
  vault_pipe_dispatcher_stop(adapter->dispatcher);
  if (adapter->thread != NULL) {
    WaitForSingleObject(adapter->thread, INFINITE);
    CloseHandle(adapter->thread);
    adapter->thread = NULL;
  }
  vault_pipe_dispatcher_destroy(adapter->dispatcher);
  adapter->dispatcher = NULL;
}

static void vault_adapter_cleanup(void *data) {
  vault_pipe_adapter *adapter = data;
  adapter->cleanup_registered = 0;
  vault_adapter_stop(adapter);
}

static void vault_adapter_finalize(napi_env env, void *data, void *hint) {
  (void)hint;
  vault_pipe_adapter *adapter = data;
  if (adapter->cleanup_registered) {
    napi_remove_env_cleanup_hook(env, vault_adapter_cleanup, adapter);
    adapter->cleanup_registered = 0;
  }
  vault_adapter_stop(adapter);
  vault_adapter_release(adapter);
}

static void vault_adapter_callback_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  vault_pipe_adapter *adapter = data;
  vault_adapter_stop(adapter);
  vault_adapter_release(adapter);
}

static void vault_adapter_delivery_free(vault_pipe_adapter *adapter, vault_pipe_delivery *delivery) {
  if (delivery == NULL) return;
  vault_pipe_wipe_free(delivery->frame, delivery->length);
  InterlockedExchangeAdd(&adapter->queued_bytes, -(LONG)delivery->length);
  free(delivery->path);
  free(delivery->sid);
  free(delivery);
}

static int vault_adapter_uint(napi_env env, napi_value object, const char *name, DWORD number) {
  napi_value value;
  return napi_create_uint32(env, number, &value) == napi_ok &&
      napi_set_named_property(env, object, name, value) == napi_ok;
}

static void vault_adapter_call_js(napi_env env, napi_value callback, void *context, void *data) {
  vault_pipe_adapter *adapter = context;
  vault_pipe_delivery *delivery = data;
  if (env != NULL && callback != NULL && adapter->dispatcher != NULL) {
    napi_value message, type, receiver, result, bytes = NULL;
    const char *kind = delivery->kind == VAULT_PIPE_VERIFY ? "verify" :
        delivery->kind == VAULT_PIPE_REQUEST ? "request" : "closed";
    int ok = napi_create_object(env, &message) == napi_ok &&
        napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &type) == napi_ok &&
        napi_set_named_property(env, message, "type", type) == napi_ok &&
        vault_adapter_uint(env, message, "slot", delivery->slot) &&
        vault_adapter_uint(env, message, "generation", delivery->generation) &&
        vault_adapter_uint(env, message, "sequence", delivery->sequence);
    if (ok && delivery->kind == VAULT_PIPE_VERIFY) {
      napi_value peer = peer_identity_value(env, delivery->pid, delivery->path, delivery->path_length, delivery->sid);
      ok = peer != NULL && napi_set_named_property(env, message, "peer", peer) == napi_ok;
    }
    if (ok && delivery->frame != NULL) {
      ok = napi_create_buffer_copy(env, delivery->length, delivery->frame, NULL, &bytes) == napi_ok &&
          napi_set_named_property(env, message, "frame", bytes) == napi_ok;
    }
    if (ok) ok = napi_get_undefined(env, &receiver) == napi_ok &&
        napi_call_function(env, receiver, callback, 1, &message, &result) == napi_ok;
    if (!ok) {
      napi_value exception = NULL;
      bool pending = false;
      if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
        napi_get_and_clear_last_exception(env, &exception);
      }
      if (bytes != NULL) {
        void *buffer = NULL;
        size_t length = 0;
        if (napi_get_buffer_info(env, bytes, &buffer, &length) == napi_ok) SecureZeroMemory(buffer, length);
      }
      InterlockedExchange(&adapter->failure, ERROR_OPERATION_ABORTED);
      if (adapter->dispatcher != NULL) vault_pipe_dispatcher_stop(adapter->dispatcher);
      if (exception != NULL) napi_fatal_exception(env, exception);
    }
  }
  vault_adapter_delivery_free(adapter, delivery);
}

static int vault_adapter_emit(void *context, const vault_pipe_event *event) {
  vault_pipe_adapter *adapter = context;
  if (adapter->callback_closing || InterlockedCompareExchange(&adapter->failure, 0, 0) != 0) return 0;
  vault_pipe_delivery *delivery = calloc(1, sizeof(*delivery));
  if (delivery == NULL) goto failure;
  delivery->kind = event->kind;
  delivery->slot = event->slot;
  delivery->generation = event->generation;
  delivery->sequence = event->request;
  if (event->kind == VAULT_PIPE_VERIFY) {
    const int verified = pipe_peer_identity(event->pipe, 1, &delivery->pid, &delivery->path, &delivery->path_length, &delivery->sid);
    HANDLE token = NULL;
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token) || GetLastError() != ERROR_NO_TOKEN) {
      if (token != NULL) CloseHandle(token);
      RevertToSelf();
      goto delivery_failure;
    }
    if (!verified) {
      vault_adapter_delivery_free(adapter, delivery);
      return 0;
    }
  }
  delivery->length = event->length;
  if (InterlockedExchangeAdd(&adapter->queued_bytes, (LONG)event->length) + (LONG)event->length >
      VAULT_PIPE_SLOTS * VAULT_PIPE_FRAME_LIMIT) goto delivery_failure;
  if (event->length != 0) {
    delivery->frame = malloc(event->length);
    if (delivery->frame == NULL) goto delivery_failure;
    memcpy(delivery->frame, event->frame, event->length);
  }
  napi_status status = napi_call_threadsafe_function(adapter->callback, delivery, napi_tsfn_nonblocking);
  if (status == napi_ok) return 1;
  if (status == napi_closing) adapter->callback_closing = 1;
delivery_failure:
  vault_adapter_delivery_free(adapter, delivery);
failure:
  InterlockedExchange(&adapter->failure, ERROR_NOT_ENOUGH_MEMORY);
  vault_pipe_dispatcher_stop(adapter->dispatcher);
  return 0;
}

static DWORD WINAPI vault_adapter_run(LPVOID data) {
  vault_pipe_adapter *adapter = data;
  DWORD failure = vault_pipe_dispatcher_run(adapter->dispatcher);
  if (failure != 0) InterlockedCompareExchange(&adapter->failure, (LONG)failure, 0);
  if (!adapter->callback_closing) napi_release_threadsafe_function(adapter->callback, napi_tsfn_release);
  return failure;
}

static napi_value start_pipe_dispatcher(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], name, result;
  napi_valuetype type;
  wchar_t *path = NULL;
  vault_pipe_adapter *existing = NULL;
  if (napi_get_instance_data(env, (void **)&existing) != napi_ok || existing != NULL ||
      napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      napi_typeof(env, argv[1], &type) != napi_ok || type != napi_function || !string_argument(env, argv[0], &path)) {
    free(path);
    napi_throw(env, make_error(env, "EINVAL", "expected one dispatcher per worker, pipe path and callback"));
    return NULL;
  }
  vault_pipe_adapter *adapter = calloc(1, sizeof(*adapter));
  if (adapter == NULL) { free(path); napi_throw(env, make_error(env, "ENOMEM", "pipe dispatcher allocation failed")); return NULL; }
  adapter->references = 1;
  if (napi_set_instance_data(env, adapter, vault_adapter_finalize, NULL) != napi_ok) {
    free(path); free(adapter); napi_throw(env, make_error(env, "ENOMEM", "pipe dispatcher ownership failed")); return NULL;
  }
  if (napi_add_env_cleanup_hook(env, vault_adapter_cleanup, adapter) != napi_ok) goto failure;
  adapter->cleanup_registered = 1;
  adapter->dispatcher = vault_pipe_dispatcher_create(path, vault_adapter_emit, adapter);
  free(path);
  path = NULL;
  if (adapter->dispatcher == NULL) goto failure;
  if (napi_create_string_utf8(env, "InFlowVaultPipeDispatcher", NAPI_AUTO_LENGTH, &name) != napi_ok) goto failure;
  InterlockedIncrement(&adapter->references);
  if (napi_create_threadsafe_function(env, argv[1], NULL, name, 64, 1, adapter,
      vault_adapter_callback_finalize, adapter, vault_adapter_call_js, &adapter->callback) != napi_ok) {
    vault_adapter_release(adapter);
    goto failure;
  }
  adapter->thread = CreateThread(NULL, 0, vault_adapter_run, adapter, 0, NULL);
  if (adapter->thread == NULL) {
    napi_release_threadsafe_function(adapter->callback, napi_tsfn_release);
    goto failure;
  }
  napi_get_undefined(env, &result);
  return result;
failure:
  free(path);
  vault_adapter_stop(adapter);
  napi_throw(env, make_error(env, "EPIPESTART", "pipe dispatcher initialization failed"));
  return NULL;
}

static napi_value stop_pipe_dispatcher(napi_env env, napi_callback_info info) {
  (void)info;
  vault_pipe_adapter *adapter = NULL;
  napi_get_instance_data(env, (void **)&adapter);
  if (adapter != NULL) vault_adapter_stop(adapter);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value pipe_dispatcher_state(napi_env env, napi_callback_info info) {
  (void)info;
  vault_pipe_adapter *adapter = NULL;
  napi_get_instance_data(env, (void **)&adapter);
  napi_value result, running;
  napi_create_object(env, &result);
  napi_get_boolean(env, adapter != NULL && adapter->thread != NULL && WaitForSingleObject(adapter->thread, 0) == WAIT_TIMEOUT, &running);
  napi_set_named_property(env, result, "running", running);
  vault_adapter_uint(env, result, "error", adapter == NULL ? 0 : (DWORD)InterlockedCompareExchange(&adapter->failure, 0, 0));
  return result;
}

static int vault_adapter_number(napi_env env, napi_value value, DWORD *number) {
  double parsed;
  if (napi_get_value_double(env, value, &parsed) != napi_ok || !(parsed >= 0 && parsed <= MAXDWORD)) return 0;
  *number = (DWORD)parsed;
  return (double)*number == parsed;
}

static napi_value submit_pipe_dispatcher(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5], result;
  DWORD slot, generation, sequence;
  bool authorized = false;
  uint8_t *frame = NULL;
  size_t length = 0;
  vault_pipe_adapter *adapter = NULL;
  napi_get_instance_data(env, (void **)&adapter);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 5 ||
      !vault_adapter_number(env, argv[0], &slot) || !vault_adapter_number(env, argv[1], &generation) ||
      !vault_adapter_number(env, argv[2], &sequence) || napi_get_value_bool(env, argv[3], &authorized) != napi_ok ||
      (sequence != 0 && !bytes_argument(env, argv[4], &frame, &length))) {
    napi_throw(env, make_error(env, "EINVAL", "expected pipe slot, generation, sequence, authorization and frame"));
    return NULL;
  }
  int accepted = adapter != NULL && adapter->dispatcher != NULL &&
      length <= VAULT_PIPE_FRAME_LIMIT &&
      vault_pipe_submit(adapter->dispatcher, slot, generation, sequence, authorized, frame, (DWORD)length);
  napi_get_boolean(env, accepted != 0, &result);
  return result;
}

#endif
