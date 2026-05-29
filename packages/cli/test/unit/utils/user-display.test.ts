import { describe, expect, it } from 'vitest';
import { formatUpdateNotice } from '../../../src/utils/update-probe.js';
import { NPM_INSTALL_COMMAND } from '../../../src/utils/user-display.js';

describe('NPM_INSTALL_COMMAND', () => {
  it('is the canonical global-install line for the published package', () => {
    expect(NPM_INSTALL_COMMAND).toBe('npm install -g @inflowpayai/inflow');
  });

  it('matches what formatUpdateNotice embeds — a typo on either side fails this test', () => {
    const notice = formatUpdateNotice({ current: '0.1.0', latest: '0.2.0' });
    expect(notice).toContain(`Run: ${NPM_INSTALL_COMMAND}`);
  });
});
