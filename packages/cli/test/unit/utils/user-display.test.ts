import { describe, expect, it } from 'vitest';
import { formatUpdateNotice } from '../../../src/utils/update-probe.js';
import { INSTALL_INSTRUCTIONS_URL } from '../../../src/utils/user-display.js';

describe('INSTALL_INSTRUCTIONS_URL', () => {
  it('is the canonical install instructions URL', () => {
    expect(INSTALL_INSTRUCTIONS_URL).toBe('https://inflowcli.ai/');
  });

  it('matches what formatUpdateNotice embeds — a typo on either side fails this test', () => {
    const notice = formatUpdateNotice({ current: '0.1.0', latest: '0.2.0' });
    expect(notice).toContain(`Install instructions: ${INSTALL_INSTRUCTIONS_URL}`);
  });
});
