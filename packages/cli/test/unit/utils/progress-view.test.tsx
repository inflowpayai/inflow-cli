import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ProgressView } from '../../../src/utils/progress-view.js';

describe('ProgressView', () => {
  it('renders the current operation', () => {
    const view = render(<ProgressView message="Inspecting Service..." />);
    expect(view.lastFrame()).toContain('Inspecting Service...');
    view.unmount();
  });
});
