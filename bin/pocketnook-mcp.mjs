#!/usr/bin/env node
/**
 * The pocketnook MCP server (GTM-010).
 *
 * Deploying belongs where the code is being written, which now means inside the
 * agent. Point a client at this file and "deploy this" becomes a private URL:
 *
 *   claude mcp add pocketnook --env POCKETNOOK_TOKEN=… -- node <this file>
 *
 * Configuration is two environment variables and nothing else:
 *   POCKETNOOK_TOKEN  an agent token from pocketnook.dev/home → "Agent access"
 *   POCKETNOOK_URL    the base URL, if not https://pocketnook.dev
 */
import { createClient } from '../src/api.js';
import { serve } from '../src/mcp.js';
import { TOOLS } from '../src/tools.js';

const client = createClient();

// A warning, not a refusal: the client starts this process at launch, often
// long before anybody deploys, and a server that exits here would show up as a
// broken MCP connection rather than as a missing token.
if (!client.hasToken) {
  process.stderr.write(
    'pocketnook-mcp: POCKETNOOK_TOKEN is not set. ' +
      `Create a token at ${client.origin}/home under "Agent access" and set it in the MCP config.\n`,
  );
}

await serve({ input: process.stdin, output: process.stdout, tools: TOOLS, client });
