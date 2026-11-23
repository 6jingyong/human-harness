/** Real local Codex app-server smoke test. Requires an installed/authenticated Codex CLI.
 * No fixture, fallback model or project database is used here.
 */
import { runCodexTask } from '../src/executors/codex';
import type { ExecutorTask } from '../src/executors/contracts';

const task: ExecutorTask = {
  packet: {
    protocol: 'hh.task/1',
    runId: 'local-smoke',
    projectId: 'local-smoke',
    workItemId: 'summary',
    objective: 'Summarize one provided sentence in Chinese. Do not use any tools.',
    readableInputs: [], templateResources: [], toolsAllowed: [], reviewPolicy: 'human_required'
  },
  stepTitle: 'Local Codex smoke test',
  evidence: [{
    artifactId: 'note', revision: 1, role: 'case_evidence', name: 'demo-note.txt',
    content: '今天收到三份材料，下一步需要核对是否齐全。'
  }],
  reviewFeedback: []
};

try {
  const output = await runCodexTask(task, {
    onEvent: event => {
      if (event.kind === 'thread' || event.kind === 'turn') {
        process.stdout.write(event.kind + ' id: ' + event.id + '\n');
      }
    }
  });
  process.stdout.write('REAL CODEX RESULT (not a fixture):\n' + JSON.stringify(output, null, 2) + '\n');
} catch (error) {
  process.stderr.write('Codex smoke test FAILED: ' +
    (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
