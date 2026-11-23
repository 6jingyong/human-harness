// A synthetic stdio MCP server for exercising a real Codex App Server locally.
import { createInterface } from 'node:readline';

const tool = {
  name: 'sample_lookup',
  description: 'Look up a synthetic record.',
  inputSchema: {
    type: 'object', properties: { sampleId: { type: 'string', enum: ['DEMO-01'] } },
    required: ['sampleId'], additionalProperties: false
  },
  annotations: { readOnlyHint: true }
};
const responses = createInterface({ input: process.stdin });
responses.on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result;
  if (method === 'initialize') {
    result = {
      protocolVersion: params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'hh-synthetic-lookup', version: '1.0.0' }
    };
  } else if (method === 'ping') {
    result = {};
  } else if (method === 'tools/list') {
    result = { tools: [tool] };
  } else if (method === 'tools/call') {
    const matches = params?.name === tool.name && params?.arguments?.sampleId === 'DEMO-01';
    result = matches ? {
      content: [{ type: 'text', text: 'Synthetic lookup succeeded.' }],
      structuredContent: { sampleId: 'DEMO-01', synthetic: true }
    } : {
      content: [{ type: 'text', text: 'Expected the synthetic identifier DEMO-01.' }],
      isError: true
    };
  }
  const response = result === undefined ? { error: { code: -32601, message: 'Method not found' } } : { result };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...response }) + '\n');
});
