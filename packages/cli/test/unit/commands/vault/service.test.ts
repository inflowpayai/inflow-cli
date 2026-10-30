import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testing, createVaultServiceCli, hasSystemdManager } from '../../../../src/commands/vault/service.js';
import { createVaultCli } from '../../../../src/commands/vault/index.js';
import { serviceStartOutput } from '../../../../src/commands/vault/schema.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  info: vi.fn(),
  dispose: vi.fn(),
  packaged: vi.fn(),
  close: vi.fn(),
  kill: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    lstatSync: vi.fn(actual.lstatSync),
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 23),
    closeSync: mocks.close,
    fstatSync: vi.fn(actual.fstatSync),
    realpathSync: vi.fn((path: string) => path),
  };
});
vi.mock('@inflowpayai/inflow-core', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return {
    ...actual,
    usesLinuxVaultService: mocks.packaged,
    LocalVaultClient: class {
      info = mocks.info;
      dispose = mocks.dispose;
    },
  };
});

function child(exitCode: number | null = null) {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    pid: 12345,
    exitCode,
    signalCode: null,
    unref: vi.fn(),
  });
}

describe('explicit system vault startup', () => {
  const getuid = process.getuid;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.packaged.mockReturnValue(true);
    mocks.info.mockResolvedValue({});
    Object.defineProperty(process, 'getuid', { configurable: true, value: vi.fn(() => 0) });
    vi.spyOn(process, 'kill').mockImplementation(mocks.kill);
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    vi.mocked(fs.mkdirSync).mockReset();
    // These filesystem fixtures supply only the metadata inspected by the launcher.
    vi.mocked(fs.lstatSync).mockReturnValue({ uid: 0, mode: 0o755, isDirectory: () => true } as fs.Stats);
    vi.mocked(fs.fstatSync).mockReturnValue({ uid: 0, mode: 0o600, nlink: 1, isFile: () => true } as fs.Stats);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Object.defineProperty(process, 'getuid', { configurable: true, value: getuid });
  });

  it('refuses non-packaged execution before any service mutation', async () => {
    mocks.packaged.mockReturnValue(false);
    await expect(__testing.startService()).rejects.toThrow('installed Linux');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('does not request elevation itself', async () => {
    vi.mocked(process.getuid)?.mockReturnValue(1000);
    await expect(__testing.startService()).rejects.toThrow('sudo inflow vault service start');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('does not mistake marker inspection errors for absence of systemd', () => {
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('permission denied');
    });
    expect(hasSystemdManager).toThrow('permission denied');
  });
  it('uses systemd on managed hosts', async () => {
    vi.mocked(fs.statSync).mockReturnValue({} as fs.Stats);
    const running = child();
    mocks.spawn.mockReturnValue(running);
    const result = __testing.startService();
    running.emit('exit', 0);
    await expect(result).resolves.toEqual({ service_state: 'running' });
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/usr/bin/systemctl',
      ['start', 'inflow-vault.socket'],
      expect.any(Object),
    );
    expect(mocks.info).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it('reports systemd start failures', async () => {
    vi.mocked(fs.statSync).mockReturnValue({} as fs.Stats);
    const running = child();
    mocks.spawn.mockReturnValue(running);
    const result = __testing.startService();
    running.emit('exit', 1);
    await expect(result).rejects.toThrow('systemd could not start');
    expect(mocks.info).not.toHaveBeenCalled();
  });
  it('requires authenticated readiness after confined startup', async () => {
    const running = child();
    mocks.spawn.mockReturnValue(running);
    const result = __testing.startService();
    running.stdout.emit('data', Buffer.from('READY\n'));
    await expect(result).resolves.toEqual({ service_state: 'running' });
    expect(mocks.info).toHaveBeenCalledOnce();
    expect(running.unref).toHaveBeenCalledOnce();
    expect(mocks.spawn.mock.calls[0]?.[1]).toContain('/opt/inflow/lib/inflow/vault-launcher');
    expect(mocks.close).toHaveBeenCalledWith(23);
  });
  it('does not report success merely because the launcher reports ready', async () => {
    const running = child();
    mocks.spawn.mockReturnValue(running);
    mocks.info.mockRejectedValue(new Error('peer verification failed'));
    const result = __testing.startService();
    running.stdout.emit('data', Buffer.from('READY\n'));
    await expect(result).rejects.toThrow('peer verification failed');
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it('refuses unsafe runtime directories', async () => {
    vi.mocked(fs.lstatSync).mockReturnValue({ uid: 1000, mode: 0o755, isDirectory: () => true } as fs.Stats);
    await expect(__testing.startService()).rejects.toThrow('Unsafe service directory');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('refuses unsafe logs', async () => {
    vi.mocked(fs.fstatSync).mockReturnValue({ uid: 0, mode: 0o666, nlink: 1, isFile: () => true } as fs.Stats);
    await expect(__testing.startService()).rejects.toThrow('Unsafe service log');
    expect(mocks.close).toHaveBeenCalledWith(23);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('bounds startup and terminates only its own process group', async () => {
    vi.useFakeTimers();
    const running = child();
    mocks.spawn.mockReturnValue(running);
    const result = expect(__testing.startService()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(mocks.kill).toHaveBeenCalledWith(-12345, 'SIGTERM');
  });
  it('reports an executable start failure without an unconfined fallback', async () => {
    const running = child();
    mocks.spawn.mockReturnValue(running);
    const result = __testing.startService();
    running.emit('error', new Error('missing bubblewrap'));
    await expect(result).rejects.toThrow('missing bubblewrap');
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });
  it('accepts an existing runtime directory but propagates creation failures', async () => {
    vi.mocked(fs.mkdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    });
    const running = child();
    mocks.spawn.mockReturnValue(running);
    const result = __testing.startService();
    running.stdout.emit('data', Buffer.from('REA'));
    expect(mocks.info).not.toHaveBeenCalled();
    running.stdout.emit('data', Buffer.from('DY\n'));
    await expect(result).resolves.toEqual({ service_state: 'running' });
    vi.mocked(fs.mkdirSync).mockImplementationOnce(() => {
      throw new Error('read only');
    });
    await expect(__testing.startService()).rejects.toThrow('read only');
  });
  it.each(['inspect', 'spawn'])('closes the log when %s fails synchronously', async (stage) => {
    if (stage === 'inspect')
      vi.mocked(fs.fstatSync).mockImplementationOnce(() => {
        throw new Error('inspection failed');
      });
    else
      mocks.spawn.mockImplementationOnce(() => {
        throw new Error('spawn failed');
      });
    await expect(__testing.startService()).rejects.toThrow('failed');
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledWith(23);
  });
  it('reports early exit without signaling an exited process', async () => {
    const exited = child(1);
    mocks.spawn.mockReturnValue(exited);
    const result = __testing.startService();
    exited.emit('exit', 1);
    await expect(result).rejects.toThrow('startup failed');
    expect(mocks.kill).not.toHaveBeenCalled();
  });
  it('refuses a missing readiness channel', async () => {
    mocks.spawn.mockReturnValue(Object.assign(child(), { stdout: null }));
    await expect(__testing.startService()).rejects.toThrow('readiness channel');
    expect(mocks.info).not.toHaveBeenCalled();
  });
  it('bounds malformed readiness output even when process cleanup races with exit', async () => {
    const running = child();
    mocks.spawn.mockReturnValue(running);
    mocks.kill.mockImplementationOnce(() => {
      throw new Error('already exited');
    });
    const result = __testing.startService();
    running.stdout.emit('data', Buffer.alloc(65, 'x'));
    running.emit('exit', 1);
    await expect(result).rejects.toThrow('Invalid service readiness');
    expect(mocks.info).not.toHaveBeenCalled();
  });
  it('reports readiness stream failure', async () => {
    const running = child();
    mocks.spawn.mockReturnValue(running);
    const result = __testing.startService();
    running.stdout.emit('error', new Error('broken readiness channel'));
    await expect(result).rejects.toThrow('broken readiness channel');
  });
  it.each([true, false])('renders the service command result (success=%s)', async (success) => {
    const output: string[] = [];
    if (success)
      mocks.spawn.mockImplementationOnce(() => {
        const running = child();
        queueMicrotask(() => running.stdout.emit('data', Buffer.from('READY\n')));
        return running;
      });
    else mocks.packaged.mockReturnValue(false);
    await createVaultServiceCli().serve(['start', '--format', 'json'], {
      exit: vi.fn(),
      stdout: (chunk) => {
        output.push(chunk);
      },
    });
    expect(output.join('')).toContain(success ? 'running' : 'VAULT_SERVICE_START_FAILED');
    if (success) expect(serviceStartOutput.parse(JSON.parse(output.join('')))).toEqual({ service_state: 'running' });
  });

  it('describes service startup without starting or contacting the service', async () => {
    let output = '';
    await createVaultServiceCli().serve(['start', '--schema', '--format', 'json'], {
      exit: vi.fn(),
      stdout: (chunk) => {
        output += chunk;
      },
    });
    expect(JSON.parse(output)).toMatchObject({
      output: {
        type: 'object',
        required: ['service_state'],
        properties: {
          service_state: { const: 'running', description: serviceStartOutput.shape.service_state.description },
        },
      },
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each([true, false])('registers service recovery only when requested (include=%s)', async (include) => {
    const output: string[] = [];
    await createVaultCli({}, include).serve(['--llms-full'], { exit: vi.fn(), stdout: (chunk) => output.push(chunk) });
    expect(output.join('').includes('service start')).toBe(include);
    if (include)
      expect(output.join('').split('### vault service start')[1]?.split('\n## ')[0]).not.toContain('#### Options');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('renders a stable error for an unexpected non-Error startup failure', async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const running = child();
      queueMicrotask(() => running.stdout.emit('data', Buffer.from('READY\n')));
      return running;
    });
    mocks.info.mockRejectedValueOnce('unexpected');
    const output: string[] = [];
    await createVaultServiceCli().serve(['start', '--format', 'json'], {
      exit: vi.fn(),
      stdout: (chunk) => output.push(chunk),
    });
    expect(output.join('')).toContain('Vault service startup failed.');
  });
});
