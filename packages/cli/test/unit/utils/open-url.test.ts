import { describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: () => undefined })));
const platformMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:os', () => ({ platform: platformMock }));

const { openUrl } = await import('../../../src/utils/open-url.js');

describe('openUrl', () => {
  it('rejects non-http(s) protocols silently', () => {
    spawnMock.mockClear();
    platformMock.mockReturnValue('darwin');
    openUrl('file:///etc/passwd');
    openUrl('javascript:alert(1)');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects malformed URLs silently', () => {
    spawnMock.mockClear();
    platformMock.mockReturnValue('linux');
    openUrl('not a url');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns `open` on darwin for http(s)', () => {
    spawnMock.mockClear();
    platformMock.mockReturnValue('darwin');
    openUrl('https://example.test/path');
    expect(spawnMock).toHaveBeenCalledWith(
      'open',
      ['https://example.test/path'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('spawns `xdg-open` on linux for http(s)', () => {
    spawnMock.mockClear();
    platformMock.mockReturnValue('linux');
    openUrl('https://example.test/');
    expect(spawnMock).toHaveBeenCalledWith(
      'xdg-open',
      ['https://example.test/'],
      expect.objectContaining({ detached: true }),
    );
  });

  it('spawns `cmd /c start "" <url>` on win32 (start is a cmd builtin)', () => {
    spawnMock.mockClear();
    platformMock.mockReturnValue('win32');
    openUrl('https://example.test/with spaces');
    expect(spawnMock).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '""', 'https://example.test/with%20spaces'],
      expect.objectContaining({ detached: true }),
    );
  });

  it('swallows spawn exceptions so the React tree is never torn down', () => {
    spawnMock.mockClear();
    spawnMock.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    platformMock.mockReturnValue('darwin');
    expect(() => openUrl('https://example.test/')).not.toThrow();
  });
});
