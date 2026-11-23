/* Protocol fixture only. No model, Codex binary, network or credentials are used. */
const { createInterface } = require('node:readline');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const mode = process.argv[2] || 'success';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let initialized = false;
let mcpCalls = 0;
const directMcp = mode.startsWith('mcp-');
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'hh-fixture' } });
  } else if (msg.method === 'initialized') {
    initialized = true;
  } else if (!initialized) {
    send({ id: msg.id, error: { code: -32000, message: 'Not initialized' } });
  } else if (msg.method === 'model/list') {
    if (mode === 'inventory' || directMcp) process.exit(18);
    else if (mode === 'select-model') {
      send({ id: msg.id, result: msg.params.cursor === 'more' ? { data: [
        { id: 'alternate', model: 'other-model', displayName: 'Other' }
      ] } : { data: [{ id: 'test-model', model: 'test-model', isDefault: true }], nextCursor: 'more' } });
    }
    else send({ id: msg.id, result: { data: [{ id: 'test-model', model: 'test-model', isDefault: true }] } });
  } else if (msg.method === 'skills/list') {
    const pluginSkill = { name: 'pdf', enabled: true, path: '/fixture/plugin/pdf/SKILL.md', pluginId: 'documents@local' };
    const installedSkills = [
      { name: 'pdf', enabled: true, path: '/fixture/skills/pdf/SKILL.md' },
      { name: 'docx', enabled: true, path: '/fixture/skills/docx/SKILL.md' }
    ];
    if (['inventory', 'plugin-skill', 'document-mcp', 'plugin-disabled', 'ambiguous-skill'].includes(mode)) installedSkills.push(pluginSkill);
    send({ id: msg.id, result: { data: [{
      cwd: msg.params.cwds[0], skills: mode === 'no-skill' ? [] : installedSkills, errors: []
    }] } });
  } else if (msg.method === 'plugin/installed') {
    send({ id: msg.id, result: { marketplaces: [{ name: 'local', plugins: [
      { id: 'documents@local', name: 'documents', installed: true, enabled: mode !== 'plugin-disabled' },
      { id: 'suggested@local', name: 'suggested', installed: false, enabled: false }
    ] }] } });
  } else if (msg.method === 'mcpServerStatus/list') {
    if (directMcp) {
      if (msg.params.threadId !== 'thread-fixture' || msg.params.serverName !== 'registry' ||
          msg.params.detail !== 'toolsAndAuthOnly') process.exit(19);
      const server = {
        name: 'registry', environmentId: 'fixture-local',
        authStatus: mode === 'mcp-auth' ? 'notLoggedIn' : 'unsupported', serverCapabilities: {},
        tools: { sample_lookup: { name: 'sample_lookup', annotations: { readOnlyHint: mode !== 'mcp-write' } } }
      };
      send({ id: msg.id, result: {
        data: mode === 'mcp-ambiguous' ? [server, { ...server, environmentId: 'fixture-other' }] : [server]
      } });
      return;
    }
    if (mode !== 'inventory' || msg.params.detail !== 'toolsAndAuthOnly') process.exit(19);
    send({ id: msg.id, result: msg.params.cursor ? { data: [{
      name: 'uninitialized', authStatus: 'unsupported', tools: {}, serverCapabilities: null
    }], nextCursor: null } : { data: [{
      name: 'example', authStatus: 'notLoggedIn', tools: { query: {} }, serverCapabilities: {}
    }], nextCursor: 'next-page' } });
  } else if (msg.method === 'mcpServer/tool/call') {
    const expected = {
      threadId: 'thread-fixture', server: 'registry', tool: 'sample_lookup',
      environmentId: 'fixture-local', arguments: { sampleId: 'DEMO-01' }
    };
    if (!['mcp-direct', 'mcp-tool-error'].includes(mode) || ++mcpCalls !== 1 ||
        JSON.stringify(msg.params) !== JSON.stringify(expected)) process.exit(21);
    send({ id: msg.id, result: {
      content: [{ type: 'text', text: 'Synthetic registry record' }],
      structuredContent: { sampleId: 'DEMO-01', source: 'Synthetic test catalog' },
      isError: mode === 'mcp-tool-error'
    } });
  } else if (msg.method === 'thread/start') {
    if (mode === 'select-model' && msg.params.model !== 'other-model') process.exit(31);
    if (!['read-only', 'workspace-write'].includes(msg.params.sandbox) || msg.params.approvalPolicy !== 'never') {
      send({ id: msg.id, error: { code: -32602, message: 'Unsafe thread permissions' } });
    } else {
      send({ id: msg.id, result: { thread: { id: 'thread-fixture' } } });
    }
  } else if (msg.method === 'turn/start') {
    if (directMcp) process.exit(22);
    if (['document', 'plugin-skill', 'document-mcp'].includes(mode)) {
      const policy = msg.params.sandboxPolicy;
      const files = readdirSync(join(process.cwd(), 'inputs'));
      const doc = files.find(name => name.endsWith('.pdf'));
      const data = doc ? readFileSync(join(process.cwd(), 'inputs', doc)) : null;
      const skillItems = msg.params.input.filter(x => x.type === 'skill');
      const expectedPath = mode === 'document' ? '/fixture/skills/pdf/SKILL.md' : '/fixture/plugin/pdf/SKILL.md';
      if (policy?.type !== 'workspaceWrite' || policy?.networkAccess !== false ||
          policy?.writableRoots?.length !== 1 || !data ||
          !data.toString().startsWith('%PDF-') ||
          skillItems.length !== 1 || skillItems[0].name !== 'pdf' || skillItems[0].path !== expectedPath) {
        send({ id: msg.id, error: { code: -32602, message: 'Invalid staged document / skill / sandbox' } });
        return;
      }
    } else if (msg.params.sandboxPolicy?.type !== 'readOnly') {
      send({ id: msg.id, error: { code: -32602, message: 'Unsafe turn permissions' } });
      return;
    }
    send({ id: msg.id, result: { turn: { id: 'turn-fixture' } } });
    if (mode === 'stalled') return; // intentionally hold the turn until host cancels
    if (mode === 'disconnect') { process.exit(7); return; }
    if (mode === 'approval') {
      send({ id: 9001, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-fixture' } });
      return;
    }
    if (mode === 'text-tool-attempt') {
      send({ method: 'item/started', params: {
        threadId: 'thread-fixture', turnId: 'turn-fixture',
        item: { id: 'tool-fixture', type: 'commandExecution', command: 'cat ../secret.txt' }
      } });
    }
    if (mode === 'document-mcp') {
      send({ method: 'item/started', params: {
        threadId: 'thread-fixture', turnId: 'turn-fixture',
        item: { id: 'mcp-fixture', type: 'mcpToolCall' }
      } });
    }
    const id = mode === 'wrong-turn' ? 'turn-foreign' : 'turn-fixture';
    let scenarioOutput;
    if (mode === 'role-b' || mode === 'role-c') {
      const taskText = (msg.params.input || []).filter(i => i.type === 'text').map(i => i.text).join('\n');
      const isB = mode === 'role-b';
      const mustContain = isB ? 'UNRELATED_A_PAYLOAD' : 'UNFOUNDED_B_PAYLOAD';
      const forbidden = isB ? 'PRIVATE_SOURCE_CANARY' : 'UNRELATED_A_PAYLOAD';
      const expectedRole = isB ? 'b-enterprise-analysis' : 'c-final-output';
      if (!taskText.includes(mustContain) || taskText.includes(forbidden) ||
          !taskText.includes(expectedRole)) {
        send({ id: msg.id, error: { code: -32602, message: 'Agent role context leaked or missing upstream result' } });
        return;
      }
      scenarioOutput = {
        body: isB
          ? '## 企业结论\n由土豆菜谱推出污染自动消失。UNFOUNDED_B_PAYLOAD'
          : '# 模拟交付\n根据已经审核的结论，土豆菜谱能消除污染。UNFOUNDED_B_PAYLOAD',
        limitations: ['Intentional CI fixture, not model reasoning'],
        materialRequests: [],
        methodChecks: (isB ? ['b1-grounded', 'b1-limit'] : ['c-consumes-b', 'c-delivery'])
          .map(checkId => ({ checkId, status: 'unverified',
            explanation: 'Simulated Codex protocol output; not professional validation',
            evidenceRefs: [] }))
      };
    }
    if (mode !== 'failed') {
      send({ method: 'item/completed', params: {
        threadId: 'thread-fixture', turnId: id,
        item: { type: 'agentMessage', text: mode === 'bad-json' ? 'not json' :
          JSON.stringify(scenarioOutput ?? (mode === 'human-request'
            ? { body: 'Original edition not stated', limitations: ['edition unknown'],
              materialRequests: [{ materialId: 'input-01', reason: '请确认资料版次' }] }
            : mode === 'method-checks'
              ? { body: 'Checks returned as candidate', limitations: [], materialRequests: [],
                methodChecks: [{ checkId: 'source-trace', status: 'unverified',
                  explanation: 'Fixture cannot verify real source', evidenceRefs: [] }] }
              : { body: 'Real protocol fixture answer', limitations: [], materialRequests: [] })) }
      } });
    }
    send({ method: 'turn/completed', params: {
      threadId: 'thread-fixture', turn: {
        id, status: mode === 'failed' ? 'failed' : 'completed',
        ...(mode === 'failed' ? { error: { message: 'Fixture model execution failed' } } : {})
      }
    } });
  } else if (msg.id === 9001) {
    if (msg.error?.code !== -32000) process.exit(8);
    send({ method: 'turn/completed', params: {
      threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'failed', error: { message: 'Approval refused' } }
    } });
  }
});
