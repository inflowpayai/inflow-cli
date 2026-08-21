import { describe, expect, it } from 'vitest';
import { accountUrlFor, approvalUrlFor, dashboardHostFor } from '../../../src/x402/dashboard-url.js';

describe('dashboardHostFor', () => {
  it('maps production api host to the dashboard host', () => {
    expect(dashboardHostFor('https://api.inflowpay.ai')).toBe('app.inflowpay.ai');
  });

  it('keeps sandbox host unchanged (api and dashboard share the host in sandbox)', () => {
    expect(dashboardHostFor('https://sandbox.inflowpay.ai')).toBe('sandbox.inflowpay.ai');
  });

  it('preserves an unknown host verbatim', () => {
    expect(dashboardHostFor('http://localhost:8080')).toBe('localhost:8080');
  });

  it('returns the raw input when the URL is unparseable', () => {
    expect(dashboardHostFor('not a url')).toBe('not a url');
  });
});

describe('approvalUrlFor', () => {
  it('builds the dashboard approval URL with the resolved host and the /view/ suffix', () => {
    expect(approvalUrlFor('https://api.inflowpay.ai', 'appr_abc')).toBe(
      'https://app.inflowpay.ai/approvals/appr_abc/view/',
    );
  });

  it('uses the raw host for self-hosted environments and appends /view/', () => {
    expect(approvalUrlFor('http://localhost:8080', 'appr_xyz')).toBe('https://localhost:8080/approvals/appr_xyz/view/');
  });

  it('always ends with /view/ — the dashboard route requires the trailing slash', () => {
    expect(approvalUrlFor('https://api.inflowpay.ai', 'appr_1')).toMatch(/\/approvals\/appr_1\/view\/$/);
  });
});

describe('accountUrlFor', () => {
  it('builds the production account URL', () => {
    expect(accountUrlFor('https://api.inflowpay.ai')).toBe('https://app.inflowpay.ai/user/');
  });

  it('builds the sandbox account URL', () => {
    expect(accountUrlFor('https://sandbox.inflowpay.ai')).toBe('https://sandbox.inflowpay.ai/user/');
  });
});
