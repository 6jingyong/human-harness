import { z } from 'zod';
import type { CodexMcpLookup } from '../protocol/v1';
import { listMcpServers, readOnlyToolNames, type CodexCall } from './codex-capabilities';
import type { ExecutorOutput, ExecutorRunEvent, ExecutorTask } from './contracts';

const toolResult = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.json().optional(),
  isError: z.boolean().nullish()
});
const textBlock = z.object({ type: z.literal('text'), text: z.string() });

export function authorizeMcpLookup(lookup: CodexMcpLookup): string {
  const selector = lookup.server + '/' + lookup.tool;
  const approved = (process.env.HH_CODEX_MCP_READ_ONLY ?? '').split(',').map(name => name.trim());
  if (!approved.includes(selector)) {
    throw new Error('Codex MCP lookup is not approved in HH_CODEX_MCP_READ_ONLY: ' + selector);
  }
  return selector;
}

export async function callCodexMcpLookup(call: CodexCall, threadId: string, lookup: CodexMcpLookup,
  selector: string, task: ExecutorTask, onEvent?: (event: ExecutorRunEvent) => void): Promise<ExecutorOutput> {
  const servers = (await listMcpServers(call, { threadId, serverName: lookup.server }))
    .filter(server => server.name === lookup.server);
  if (servers.length !== 1) {
    throw new Error(servers.length ? 'Ambiguous Codex MCP server registration: ' + lookup.server
      : 'Codex MCP server is not configured for the task thread: ' + lookup.server);
  }
  const [server] = servers;
  if (!server.serverCapabilities || server.toolsError ||
      !['unsupported', 'bearerToken', 'oAuth'].includes(server.authStatus)) {
    throw new Error('Codex MCP server is not ready or authorized: ' + lookup.server);
  }
  if (!readOnlyToolNames(server.tools).includes(lookup.tool)) {
    throw new Error('Codex MCP tool is missing or does not advertise readOnlyHint: ' + selector);
  }
  const raw = await call('mcpServer/tool/call', {
    threadId, server: lookup.server, tool: lookup.tool,
    ...(server.environmentId ? { environmentId: server.environmentId } : {}),
    arguments: lookup.arguments ?? {}
  });
  const parsed = toolResult.safeParse(raw);
  if (!parsed.success) throw new Error('Unsupported Codex MCP tool response: ' + selector);
  if (parsed.data.isError) throw new Error('Codex MCP tool reported an error: ' + selector);
  const blocks = z.array(textBlock).safeParse(parsed.data.content);
  if (!blocks.success) throw new Error('Codex MCP lookup accepts text or structured JSON only: ' + selector);
  const json = JSON.stringify({
    server: lookup.server, tool: lookup.tool,
    text: blocks.data.map(block => block.text), structuredContent: parsed.data.structuredContent
  }, null, 2);
  if (json.length > 80000) throw new Error('Codex MCP lookup response exceeds 80000 characters: ' + selector);
  onEvent?.({ kind: 'mcpLookup', selector });
  return {
    body: task.outputFormat === 'json' ? json : '# MCP 查询结果\n\n```json\n' + json + '\n```',
    limitations: ['此成果记录只读工具的返回值，仍需人工审核其来源与适用性。'],
    materialRequests: [],
    ...(task.workMethod ? { methodChecks: task.workMethod.checks.map(check => ({
      checkId: check.id, status: 'unverified' as const,
      explanation: '只读查询未执行项目核验项。', evidenceRefs: []
    })) } : {})
  };
}
