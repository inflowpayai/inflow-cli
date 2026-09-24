import { type IOdpResource } from '@inflowpayai/inflow-core';
import { Cli } from 'incur';
import { mcpTool } from '../../mcp-metadata.js';
import { renderInkUntilExit } from '../../utils/render-ink-until-exit.js';
import { inspectArgs, inspectOptions } from './schema.js';
import { createCollectionsCli, InspectionView, runInspect } from './service.js';
import { createOfferingsCli } from './offerings.js';
import { createActionsCli } from './actions.js';
import { executeOdpCommand, type OdpCommandContext } from './command.js';

interface InspectCommandContext extends OdpCommandContext {
  agent: boolean;
  formatExplicit: boolean;
  args: { service: string };
  options: { language?: string | undefined };
}

function createInspectCommand(resource: Pick<IOdpResource, 'inspect'>) {
  return {
    args: inspectArgs,
    description: "Inspect a service's capabilities.",
    mcp: mcpTool('odp_inspect'),
    options: inspectOptions,
    outputPolicy: 'agent-only' as const,
    async run(c: InspectCommandContext) {
      return executeOdpCommand(
        c,
        () => runInspect(resource, c.args.service, c.options.language),
        async (result) => {
          if (!c.agent && !c.formatExplicit) await renderInkUntilExit(<InspectionView inspection={result} />);
        },
        { code: 'ODP_INSPECT_FAILED', message: 'ODP Service inspection failed.', retryable: false },
      );
    },
  };
}

export function createInspectCli(resource: Pick<IOdpResource, 'inspect'>) {
  const cli = Cli.create('odp', { description: 'Offering Discovery Protocol commands' });
  cli.command('inspect', createInspectCommand(resource));
  return cli;
}

export function createOdpCli(resource: IOdpResource) {
  const cli = createInspectCli(resource);
  cli.command(createActionsCli(resource));
  cli.command(createCollectionsCli(resource));
  cli.command(createOfferingsCli(resource));
  return cli;
}
