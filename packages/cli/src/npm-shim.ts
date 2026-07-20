import process from 'node:process';
import { fileURLToPath } from 'node:url';

declare const __CLI_VERSION__: string;

const installUrl = 'https://inflowcli.ai/';
const code = 'NPM_CLI_DEPRECATED';
const message = 'The npm package no longer runs InFlow commands. Install the signed native InFlow CLI.';

export function isNpmShimAgentMode(args: readonly string[], stdoutIsTty: boolean | undefined): boolean {
  if (args.includes('--help') || args.includes('-h')) return false;
  return (
    args.includes('--mcp') ||
    args.includes('--format') ||
    args.some((arg) => arg.startsWith('--format=')) ||
    !stdoutIsTty
  );
}

export function renderNpmShimAgentPayload(packageVersion: string): string {
  return `${JSON.stringify({
    ok: false,
    code,
    message,
    install_url: installUrl,
    package_version: packageVersion,
  })}\n`;
}

export function renderNpmShimHumanMessage(): string {
  return [
    'InFlow CLI is distributed as a signed native application.',
    '',
    'Install or update InFlow:',
    `  ${installUrl}`,
    '',
    'This npm package is a compatibility notice. It does not run commands, start MCP, or manage credentials.',
    '',
  ].join('\n');
}

interface NpmShimWritable {
  write(text: string, callback: () => void): boolean;
}

export interface RunNpmShimOptions {
  args: readonly string[];
  packageVersion: string;
  stderr: NpmShimWritable;
  stdout: NpmShimWritable;
  stdoutIsTty: boolean | undefined;
}

async function write(text: string, stream: NpmShimWritable): Promise<void> {
  return new Promise((resolve) => {
    stream.write(text, () => {
      resolve();
    });
  });
}

export async function runNpmShim(options: RunNpmShimOptions): Promise<number> {
  if (isNpmShimAgentMode(options.args, options.stdoutIsTty)) {
    await write(renderNpmShimAgentPayload(options.packageVersion), options.stdout);
  } else {
    await write(renderNpmShimHumanMessage(), options.stderr);
  }
  return 1;
}

/* v8 ignore start */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runNpmShim({
    args: process.argv,
    packageVersion: __CLI_VERSION__,
    stderr: process.stderr,
    stdout: process.stdout,
    stdoutIsTty: process.stdout.isTTY,
  }).then((exitCode) => {
    process.exit(exitCode);
  });
}
/* v8 ignore stop */
