import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (!isMainThread) {
  const native = createRequire(import.meta.url)(workerData.module);
  let failedFrame;
  if (workerData.throwCallback) {
    process.once('uncaughtException', (error) => {
      assert.equal(error.message, 'callback fixture failure');
      assert.deepEqual(failedFrame, Buffer.alloc(5));
      setTimeout(() => parentPort.postMessage({ failed: true, state: native.pipeDispatcherState() }), 100);
    });
  }
  native.startPipeDispatcher(workerData.pipe, (event) => {
    if (event.type === 'verify') {
      assert.equal(event.peer.pid, process.pid);
      assert.equal(event.peer.path.toLowerCase(), process.execPath.toLowerCase());
      assert.match(event.peer.principal, /^S-\d+(?:-\d+)+$/u);
      const accepted = native.submitPipeDispatcher(event.slot, event.generation, 0, !workerData.deny, null);
      if (!workerData.pressure) assert.equal(accepted, true);
    } else if (event.type === 'request') {
      if (workerData.throwCallback) {
        failedFrame = event.frame;
        throw new Error('callback fixture failure');
      }
      assert.equal(
        native.submitPipeDispatcher(event.slot, event.generation + 1, event.sequence, false, event.frame),
        false,
      );
      assert.equal(
        native.submitPipeDispatcher(event.slot, event.generation, event.sequence + 1, false, event.frame),
        false,
      );
      assert.equal(native.submitPipeDispatcher(event.slot, event.generation, event.sequence, false, event.frame), true);
      assert.equal(
        native.submitPipeDispatcher(event.slot, event.generation, event.sequence, false, event.frame),
        false,
      );
      event.frame.fill(0);
    }
  });
  parentPort.on('message', () => {
    native.stopPipeDispatcher();
    native.stopPipeDispatcher();
    assert.equal(native.pipeDispatcherState().running, false);
    parentPort.postMessage({ stopped: true, state: native.pipeDispatcherState() });
    parentPort.close();
  });
  parentPort.postMessage({ ready: true });
  if (workerData.pressure) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12500);
    setTimeout(() => parentPort.postMessage({ pressure: true, state: native.pipeDispatcherState() }), 100);
  }
} else {
  assert.equal(process.platform, 'win32');
  const module = resolve(process.argv[2]);
  let index = 0;
  const sockets = new Set();
  const workers = new Set();
  function waitMessage(worker, key) {
    return new Promise((resolveMessage, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${key}`)), 20000);
      const onMessage = (message) => {
        if (message[key]) finish(undefined, message);
      };
      const onError = (error) => finish(error);
      function finish(error, message) {
        clearTimeout(timeout);
        worker.off('message', onMessage);
        worker.off('error', onError);
        if (error) reject(error);
        else resolveMessage(message);
      }
      worker.on('message', onMessage);
      worker.on('error', onError);
    });
  }
  async function start(options = {}) {
    const pipe = options.pipe ?? `\\\\.\\pipe\\InFlowAdapterTest-${process.pid}-${++index}`;
    const worker = new Worker(new URL(import.meta.url), { workerData: { module, pipe, ...options } });
    workers.add(worker);
    await waitMessage(worker, 'ready');
    return { worker, pipe };
  }
  function connect(pipe) {
    return new Promise((resolveConnection, reject) => {
      const socket = net.createConnection(pipe);
      sockets.add(socket);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connect timeout'));
      }, 5000);
      socket.on('error', reject);
      socket.once('connect', () => {
        clearTimeout(timeout);
        resolveConnection(socket);
      });
      socket.once('close', () => {
        clearTimeout(timeout);
        sockets.delete(socket);
      });
    });
  }
  function exchange(socket, payload) {
    const frame = Buffer.from([0, 0, 0, 1, payload]);
    return new Promise((resolveExchange, reject) => {
      let received = Buffer.alloc(0);
      const timeout = setTimeout(() => finish(new Error('Exchange timeout')), 5000);
      const onData = (bytes) => {
        received = Buffer.concat([received, bytes]);
        if (received.length >= frame.length) finish();
      };
      const onError = (error) => finish(error);
      function finish(error) {
        clearTimeout(timeout);
        socket.off('data', onData);
        socket.off('error', onError);
        if (error) reject(error);
        else {
          try {
            assert.deepEqual(received, frame);
            resolveExchange();
          } catch (cause) {
            reject(cause);
          }
        }
      }
      socket.on('data', onData);
      socket.on('error', onError);
      socket.write(frame);
    });
  }
  async function stop(worker) {
    const stopped = waitMessage(worker, 'stopped');
    const exit = new Promise((resolveExit) => worker.once('exit', resolveExit));
    worker.postMessage('stop');
    const result = await stopped;
    assert.equal(await exit, 0);
    workers.delete(worker);
    return result;
  }
  try {
    const first = await start();
    const idle = await connect(first.pipe);
    idle.write('INFLOWV1');
    const active = await connect(first.pipe);
    active.write('INFLOWV1');
    for (let value = 0; value < 10; value++) await exchange(active, value);
    assert.equal((await stop(first.worker)).state.error, 0);

    const terminated = await start();
    const pending = await connect(terminated.pipe);
    pending.write('INF');
    await terminated.worker.terminate();
    workers.delete(terminated.worker);
    const replacement = await start({ pipe: terminated.pipe });
    await stop(replacement.worker);

    const queued = await start({ pressure: true });
    const queuedClients = await Promise.all(Array.from({ length: 8 }, () => connect(queued.pipe)));
    for (const client of queuedClients) client.write('INFLOWV1');
    await delay(100);
    await queued.worker.terminate();
    workers.delete(queued.worker);
    const afterQueued = await start({ pipe: queued.pipe });
    await stop(afterQueued.worker);

    const denied = await start({ deny: true });
    const refused = await connect(denied.pipe);
    const closed = new Promise((resolveClose) => refused.once('close', resolveClose));
    refused.write('INFLOWV1');
    await Promise.race([
      closed,
      delay(5000).then(() => {
        throw new Error('Denied peer remained open');
      }),
    ]);
    await stop(denied.worker);

    const throwing = await start({ throwCallback: true });
    const failed = waitMessage(throwing.worker, 'failed');
    const triggering = await connect(throwing.pipe);
    triggering.write(Buffer.concat([Buffer.from('INFLOWV1'), Buffer.from([0, 0, 0, 1, 42])]));
    const failure = (await failed).state;
    assert.equal(failure.running, false);
    assert.notEqual(failure.error, 0);
    await stop(throwing.worker);

    const pressure = await start({ pressure: true });
    const observed = waitMessage(pressure.worker, 'pressure');
    const clients = await Promise.all(Array.from({ length: 32 }, () => connect(pressure.pipe)));
    for (const client of clients) client.write('INFLOWV1');
    await delay(10800);
    await Promise.allSettled(
      Array.from({ length: 32 }, async () => {
        const client = await connect(pressure.pipe);
        client.write('INFLOWV1');
      }),
    );
    const state = (await observed).state;
    assert.equal(state.running, false);
    assert.notEqual(state.error, 0);
    await stop(pressure.worker);
    process.stdout.write(
      'PASS: native adapter identity, concurrent callbacks, sequencing, denial, callback exception cleanup, bounded queue failure, stop and worker termination\n',
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([...workers].map((worker) => worker.terminate()));
  }
}
