import { runCodexTask } from '../src/executors/codex';
import { codexMcpLookupSchema } from '../src/protocol/v1';

const usage = 'Usage: npm run codex:mcp:smoke -- <server> <tool> [arguments-json-object]';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
} else {
  try {
    if (args.length < 2 || args.length > 3) throw new Error(usage);
    const [server, tool, argumentsJson] = args;
    let query: unknown;
    try { query = argumentsJson === undefined ? undefined : JSON.parse(argumentsJson); }
    catch { throw new Error('MCP arguments must be a valid JSON object.'); }
    const lookup = codexMcpLookupSchema.safeParse({ server, tool, arguments: query });
    if (!lookup.success) {
      throw new Error('Invalid MCP lookup. Verify the server, tool and JSON object arguments.');
    }

    let received = 0;
    let modelTurn = false;
    // Use only the configured Codex binary. This run carries no project or material data.
    await runCodexTask({
      packet: {
        protocol: 'hh.task/1', runId: 'mcp-smoke', projectId: 'mcp-smoke', workItemId: 'lookup',
        objective: 'Verify a direct read-only MCP query', codexMcp: lookup.data,
        readableInputs: [], templateResources: [], toolsAllowed: [], reviewPolicy: 'human_required'
      },
      stepTitle: 'Read-only MCP smoke test', outputFormat: 'json', evidence: [], reviewFeedback: []
    }, {
      onEvent: event => {
        if (event.kind === 'mcpLookup' && event.selector === server + '/' + tool) received++;
        if (event.kind === 'turn') modelTurn = true;
      }
    });
    if (received !== 1 || modelTurn) throw new Error('Unexpected Codex execution trace.');
    console.log('Codex MCP smoke test passed for ' + server + '/' + tool + '.');
  } catch (error) {
    console.error('Codex MCP smoke test failed: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
