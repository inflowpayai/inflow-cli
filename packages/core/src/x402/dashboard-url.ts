const API_HOST_TO_DASHBOARD: Record<string, string> = {
  'api.inflowpay.ai': 'app.inflowpay.ai',
  'sandbox.inflowpay.ai': 'sandbox.inflowpay.ai',
};

export function dashboardHostFor(apiBaseUrl: string): string {
  let host: string;
  try {
    host = new URL(apiBaseUrl).host;
  } catch {
    return apiBaseUrl;
  }
  return API_HOST_TO_DASHBOARD[host] ?? host;
}

export function approvalUrlFor(apiBaseUrl: string, approvalId: string): string {
  const host = dashboardHostFor(apiBaseUrl);
  return `https://${host}/approvals/${approvalId}/view/`;
}

export function accountUrlFor(apiBaseUrl: string): string {
  return `https://${dashboardHostFor(apiBaseUrl)}/user/`;
}
