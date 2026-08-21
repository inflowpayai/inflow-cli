import { Mcp } from 'incur';
import { describe, expect, it, vi } from 'vitest';

function streamingTool(
  run: (context: { error: (input: { code: string; details?: unknown; message: string }) => never }) => unknown,
) {
  return {
    name: 'streaming_test',
    description: 'Streaming MCP test command',
    inputSchema: { type: 'object' as const, properties: {} },
    command: { run },
  };
}

describe('MCP streaming command errors', () => {
  it('surfaces a generator return c.error as an MCP tool error', async () => {
    const result = await Mcp.callTool(
      streamingTool(async function* (context) {
        await Promise.resolve();
        yield { phase: 'started' };
        return context.error({ code: 'VAULT_LOCKED', message: 'The InFlow vault is locked.' });
      }),
      {},
    );

    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'The InFlow vault is locked.' }],
      isError: true,
    });
  });

  it('includes structured details in an MCP tool error', async () => {
    const result = await Mcp.callTool(
      streamingTool(({ error }) =>
        error({
          code: 'ACTION_REQUIRED',
          details: { action: 'update_account' },
          message: 'Account information is required.',
        }),
      ),
      {},
    );

    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            code: 'ACTION_REQUIRED',
            details: { action: 'update_account' },
            message: 'Account information is required.',
          }),
        },
      ],
      isError: true,
    });
  });

  it('includes structured details returned by a streaming MCP tool error', async () => {
    const result = await Mcp.callTool(
      streamingTool(async function* ({ error }) {
        await Promise.resolve();
        return error({
          code: 'ACTION_REQUIRED',
          details: { action: 'update_account' },
          message: 'Account information is required.',
        });
      }),
      {},
    );

    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            code: 'ACTION_REQUIRED',
            details: { action: 'update_account' },
            message: 'Account information is required.',
          }),
        },
      ],
      isError: true,
    });
  });

  it('continues to buffer successful generator chunks', async () => {
    const result = await Mcp.callTool(
      streamingTool(async function* () {
        await Promise.resolve();
        yield { phase: 'started' };
        yield { phase: 'complete' };
      }),
      {},
    );

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: '[{"phase":"started"},{"phase":"complete"}]',
        },
      ],
    });
  });

  it('closes the generator when a progress notification fails', async () => {
    let finalized = false;
    const result = await Mcp.callTool(
      streamingTool(async function* () {
        try {
          await Promise.resolve();
          yield { phase: 'started' };
          yield { phase: 'complete' };
        } finally {
          finalized = true;
        }
      }),
      {},
      {
        extra: { mcpReq: { _meta: { progressToken: 'progress-1' } } },
        sendNotification: vi.fn().mockRejectedValue(new Error('progress delivery failed')),
      },
    );

    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'progress delivery failed' }],
      isError: true,
    });
    expect(finalized).toBe(true);
  });
});
