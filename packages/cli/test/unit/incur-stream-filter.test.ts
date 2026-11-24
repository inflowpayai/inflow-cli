import { Cli } from 'incur';
import { describe, expect, it, vi } from 'vitest';

describe('Incur streaming output filtering', () => {
  it.each(['jsonl', 'json', 'implicit-toon'])('filters each data object in %s output', async (format) => {
    const cli = Cli.create('test');
    cli.command('stream', {
      async *run() {
        yield await Promise.resolve({
          outcome: 'pending',
          transaction: { id: 'tx-1', credential: 'SECRET' },
          credential: 'SECRET',
        });
        yield { outcome: 'paid', transaction: { id: 'tx-1', credential: 'SECRET' }, credential: 'SECRET' };
      },
    });
    let output = '';
    const exit = vi.fn();
    await cli.serve(
      [
        'stream',
        ...(format === 'implicit-toon' ? [] : ['--format', format]),
        '--filter-output',
        'outcome,transaction.id',
      ],
      {
        exit,
        stdout: (value) => {
          output += value;
        },
      },
    );
    expect(output).not.toContain('SECRET');
    expect(output).not.toContain('credential');
    expect(output).toContain('pending');
    expect(output).toContain('paid');
    expect(output).toContain('tx-1');
    expect(exit).not.toHaveBeenCalled();
    if (format === 'jsonl') {
      const records: unknown[] = output
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line));
      expect(records).toHaveLength(3);
      expect(records.slice(0, 2)).toEqual([
        { type: 'chunk', data: { outcome: 'pending', transaction: { id: 'tx-1' } } },
        { type: 'chunk', data: { outcome: 'paid', transaction: { id: 'tx-1' } } },
      ]);
      expect(records[2]).toMatchObject({ type: 'done', ok: true, meta: { command: 'stream' } });
      expect(records[2]).toHaveProperty('meta.duration', expect.any(String));
    }
  });

  it.each(['yield', 'return'])('preserves a %s error envelope independently of the data filter', async (mode) => {
    const cli = Cli.create('test');
    cli.command('stream', {
      async *run(c) {
        yield await Promise.resolve({ outcome: 'pending', extra: 'excluded' });
        const error = c.error({ code: 'POLLING_TIMEOUT', message: 'Timed out.', retryable: true });
        if (mode === 'yield') yield error;
        else return error;
      },
    });
    let output = '';
    const exit = vi.fn();
    await cli.serve(['stream', '--format', 'jsonl', '--filter-output', 'outcome'], {
      exit,
      stdout: (value) => {
        output += value;
      },
    });
    expect(
      output
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line)),
    ).toEqual([
      { type: 'chunk', data: 'pending' },
      { type: 'error', ok: false, error: { code: 'POLLING_TIMEOUT', message: 'Timed out.', retryable: true } },
    ]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('preserves unfiltered output when no filter is requested', async () => {
    const cli = Cli.create('test');
    cli.command('stream', {
      async *run() {
        yield await Promise.resolve({ outcome: 'paid', extra: 'included' });
      },
    });
    let output = '';
    await cli.serve(['stream', '--format', 'jsonl'], {
      stdout: (value) => {
        output += value;
      },
      exit: vi.fn(),
    });
    expect(JSON.parse(output.split('\n')[0] ?? '')).toEqual({
      type: 'chunk',
      data: { outcome: 'paid', extra: 'included' },
    });
  });
});
