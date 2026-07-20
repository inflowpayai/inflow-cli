import { describe, expect, it } from 'vitest';
import { INSTALL_INSTRUCTIONS_URL } from '../../../src/utils/user-display.js';

describe('INSTALL_INSTRUCTIONS_URL', () => {
  it('is the canonical install instructions URL', () => {
    expect(INSTALL_INSTRUCTIONS_URL).toBe('https://inflowcli.ai/');
  });
});
