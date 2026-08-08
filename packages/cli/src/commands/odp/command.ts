export interface OdpCommandErrorDetail {
  code: string;
  exitCode?: number;
  message: string;
  retryable?: boolean;
}

export interface OdpCommandContext {
  error(detail: OdpCommandErrorDetail): never;
}

export class OdpCommandError extends Error {
  constructor(readonly detail: OdpCommandErrorDetail) {
    super(detail.message);
  }
}

export function odpCommandError(detail: OdpCommandErrorDetail): never {
  throw new OdpCommandError(detail);
}

export async function executeOdpCommand<Result>(
  context: OdpCommandContext,
  operation: () => Promise<Result> | Result,
  present: (result: Result) => Promise<void>,
  fallback: OdpCommandErrorDetail,
): Promise<Result> {
  try {
    const result = await operation();
    await present(result);
    return result;
  } catch (error) {
    return context.error(error instanceof OdpCommandError ? error.detail : fallback);
  }
}
