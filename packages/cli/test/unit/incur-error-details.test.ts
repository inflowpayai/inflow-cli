import { Cli } from 'incur';
import { describe, expect, it, vi } from 'vitest';

describe('Incur structured error details', () => {
  it('uses the optional title for human-readable expected-state errors', async () => {
    const stdoutAsTty = process.stdout as unknown as { isTTY?: boolean };
    const originalIsTTY = stdoutAsTty.isTTY;
    stdoutAsTty.isTTY = true;
    const cli = Cli.create('test');
    cli.command('fail', {
      run: (context) =>
        context.error({
          code: 'ACTION_REQUIRED',
          message: 'Account information is required.',
          retryable: false,
          title: 'Enrollment needs account information',
        }),
    });
    let output = '';
    const exit = vi.fn();

    try {
      await cli.serve(['fail'], {
        exit,
        stdout: (value) => {
          output += value;
        },
      });
    } finally {
      if (originalIsTTY === undefined) delete stdoutAsTty.isTTY;
      else stdoutAsTty.isTTY = originalIsTTY;
    }

    expect(output).toContain('Enrollment needs account information\n\nAccount information is required.');
    expect(output).not.toContain('Error (ACTION_REQUIRED)');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('preserves details in agent output while retaining a failure exit code', async () => {
    const cli = Cli.create('test');
    cli.command('fail', {
      run: (context) =>
        context.error({
          code: 'ACTION_REQUIRED',
          details: { action: 'update_account' },
          message: 'Account information is required.',
          retryable: false,
          title: 'Enrollment needs account information',
        }),
    });
    let output = '';
    const exit = vi.fn();

    await cli.serve(['fail', '--format', 'json', '--full-output'], {
      exit,
      stdout: (value) => {
        output += value;
      },
    });

    expect(JSON.parse(output)).toMatchObject({
      error: {
        code: 'ACTION_REQUIRED',
        details: { action: 'update_account' },
        message: 'Account information is required.',
        retryable: false,
        title: 'Enrollment needs account information',
      },
      ok: false,
    });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
