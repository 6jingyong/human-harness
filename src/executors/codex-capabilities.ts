import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';

export type CodexCall = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
const skill = z.object({
  name: z.string().min(1), path: z.string(), enabled: z.boolean(),
  pluginId: z.string().nullish()
});
const plugin = z.object({
  id: z.string().min(1), name: z.string().min(1), enabled: z.boolean(), installed: z.boolean()
});
const mcpServer = z.object({
  name: z.string().min(1), authStatus: z.string(),
  environmentId: z.string().nullish(),
  tools: z.record(z.string(), z.unknown()), toolsError: z.unknown().optional(),
  serverCapabilities: z.object({}).nullish()
});
const mcpTool = z.object({
  name: z.string().min(1),
  annotations: z.object({ readOnlyHint: z.boolean().optional() }).nullish()
});

async function localSkills(call: CodexCall, cwd: string) {
  const { data } = z.object({
    data: z.array(z.object({ skills: z.array(skill), errors: z.array(z.unknown()).optional() }))
  }).parse(await call('skills/list', { cwds: [cwd], forceReload: true }));
  return {
    items: data.flatMap(group => group.skills),
    loadErrors: data.reduce((total, group) => total + (group.errors?.length ?? 0), 0)
  };
}

async function installedPlugins(call: CodexCall, cwd: string) {
  const result = z.object({
    marketplaces: z.array(z.object({ plugins: z.array(plugin) })),
    marketplaceLoadErrors: z.array(z.unknown()).optional()
  }).parse(await call('plugin/installed', { cwds: [cwd] }));
  return {
    items: result.marketplaces.flatMap(market => market.plugins).filter(item => item.installed),
    loadErrors: result.marketplaceLoadErrors?.length ?? 0
  };
}

export async function listMcpServers(call: CodexCall, scope: { threadId?: string; serverName?: string } = {}) {
  const response = z.object({ data: z.array(mcpServer), nextCursor: z.string().nullish() });
  const servers: z.infer<typeof mcpServer>[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = response.parse(await call('mcpServerStatus/list', {
      ...scope, detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? { cursor } : {})
    }));
    servers.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Codex returned a repeated MCP status cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return servers;
}

export function readOnlyToolNames(tools: Record<string, unknown>) {
  return Object.values(tools).flatMap(raw => {
    const tool = mcpTool.safeParse(raw);
    return tool.success && tool.data.annotations?.readOnlyHint === true ? [tool.data.name] : [];
  });
}

async function tryProbe<T extends object>(probe: () => Promise<T>) {
  try { return { ok: true as const, ...await probe() }; }
  catch (error) {
    return { ok: false as const, error: error instanceof z.ZodError
      ? 'Codex returned an unsupported inventory response shape'
      : error instanceof Error ? error.message : String(error) };
  }
}

export async function readCodexCapabilities(call: CodexCall, cwd: string, includeMcp: boolean) {
  const [skills, plugins, mcp] = await Promise.all([
    tryProbe(async () => {
      const { items, loadErrors } = await localSkills(call, cwd);
      return { items: items.map(({ name, enabled, pluginId }) => ({
        name, enabled, ...(pluginId ? { pluginId } : {})
      })), loadErrors };
    }),
    tryProbe(() => installedPlugins(call, cwd)),
    includeMcp ? tryProbe(async () => ({
      items: (await listMcpServers(call)).map(server => ({
        name: server.name, authStatus: server.authStatus,
        initialized: server.serverCapabilities === undefined ? null : server.serverCapabilities !== null,
        toolCount: Object.keys(server.tools).length, toolListError: Boolean(server.toolsError),
        readOnlyTools: readOnlyToolNames(server.tools)
      })), loadErrors: 0
    })) : null
  ]);
  return { skills, plugins, mcp };
}

/** Match only enabled Skills returned by the current host. Names never become file paths. */
export async function resolveCodexSkills(call: CodexCall, cwd: string, selectors: readonly string[]) {
  if (!selectors.length) return [];
  const { items } = await localSkills(call, cwd);
  const resolved = new Map<string, z.infer<typeof skill>>();
  for (const selector of selectors) {
    const separator = selector.lastIndexOf('/');
    const pluginId = separator === -1 ? undefined : selector.slice(0, separator);
    const name = selector.slice(separator + 1);
    const matches = new Map(items.filter(item => item.enabled && item.name === name &&
      (!pluginId || item.pluginId === pluginId)).map(item => [item.path, item]));
    if (!matches.size) throw new Error('Required local Codex Skill not installed/enabled: ' + selector);
    if (matches.size > 1) {
      throw new Error('Ambiguous Codex Skill: ' + selector + '. Specify plugin-id/skill-name in the template.');
    }
    const selected = [...matches.values()][0];
    if (!isAbsolute(selected.path) || basename(selected.path) !== 'SKILL.md') {
      throw new Error('Codex skills/list has no usable absolute SKILL.md path for ' + selector);
    }
    resolved.set(selected.path, selected);
  }
  const itemsToRun = [...resolved.values()];
  if (itemsToRun.some(item => item.pluginId)) {
    const { items: installed } = await installedPlugins(call, cwd);
    const enabled = new Set(installed.filter(item => item.enabled).map(item => item.id));
    for (const item of itemsToRun) {
      if (item.pluginId && !enabled.has(item.pluginId)) {
        throw new Error('Required local Codex Plugin not installed/enabled: ' + item.pluginId);
      }
    }
  }
  return itemsToRun;
}
