/* Protocol fixture only. No model, Codex binary, network or credentials are used. */
const { createInterface } = require('node:readline');
const mode = process.argv[2] || 'success';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let initialized = false;
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'hh-fixture' } });
  } else if (msg.method === 'initialized') {
    initialized = true;
  } else if (!initialized) {
    send({ id: msg.id, error: { code: -32000, message: 'Not initialized' } });
  } else if (msg.method === 'model/list') {
    send({ id: msg.id, result: { data: [{ id: 'test-model', model: 'test-model', isDefault: true }] } });
  } else if (msg.method === 'thread/start') {
    if (msg.params.sandbox !== 'read-only' || msg.params.approvalPolicy !== 'never') {
      send({ id: msg.id, error: { code: -32602, message: 'Unsafe thread permissions' } });
    } else {
      send({ id: msg.id, result: { thread: { id: 'thread-fixture' } } });
    }
  } else if (msg.method === 'turn/start') {
    if (msg.params.sandboxPolicy?.type !== 'readOnly') {
      send({ id: msg.id, error: { code: -32602, message: 'Unsafe turn permissions' } });
      return;
    }
    send({ id: msg.id, result: { turn: { id: 'turn-fixture' } } });
    if (mode === 'disconnect') { process.exit(7); return; }
    if (mode === 'approval') {
      send({ id: 9001, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-fixture' } });
      return;
    }
    const id = mode === 'wrong-turn' ? 'turn-foreign' : 'turn-fixture';
    if (mode !== 'failed') {
      send({ method: 'item/completed', params: {
        threadId: 'thread-fixture', turnId: id,
        item: { type: 'agentMessage', text: mode === 'bad-json' ? 'not json' :
          JSON.stringify({ body: 'Real protocol fixture answer', limitations: [], materialRequests: [] }) }
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
