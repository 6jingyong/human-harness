import type { ExecutorOutput, ExecutorTask, TaskExecutor } from './contracts';

/**
 * One built-in, deterministically rendered capability. Template JSON contains
 * data and dependencies, never arbitrary executable source or shell commands.
 *
 * This renderer does not judge whether an upstream conclusion is correct: that
 * is intentionally owned by the producing Agent and Human approval.
 */
export const markdownAssemblyExecutor: TaskExecutor = {
  id: 'hh.render.markdown',
  async execute(task: ExecutorTask): Promise<ExecutorOutput> {
    if (task.executionCapabilityId !== 'hh.render.markdown' ||
        task.outputFormat !== 'markdown') {
      throw new Error('Unsupported deterministic script capability or output format');
    }
    if (!task.evidence.length) throw new Error('Markdown assembly requires reviewed upstream artifacts');
    if (task.evidence.some(e => e.role !== 'approved_derived' || typeof e.content !== 'string')) {
      throw new Error('Markdown assembly may consume only readable, reviewed upstream outputs');
    }
    // Do not combine source material or old rejected output. The runtime task
    // packet already resolves precisely the currently accepted dependencies.
    const sections = task.evidence.map(e => '## ' + e.name.replace(/[\r\n]+/g, ' ') +
      '\n\n' + e.content!.trim());
    const human = (task.humanHandoffs ?? []).map(h =>
      '### ' + h.stepId.replace(/[\r\n]+/g, ' ') + '\n\n' + h.value.trim());
    const body = [
      '# ' + task.stepTitle.replace(/[\r\n]+/g, ' '),
      ...sections,
      ...(human.length ? ['## 人工交接记录（原文）', ...human] : [])
    ].join('\n\n') + '\n';
    if (body.length > 120000) {
      throw new Error('Assembled Markdown exceeds output contract size limit');
    }
    return {
      body,
      limitations: ['Deterministic assembly only; no independent factual verification or layout generation was performed.'],
      materialRequests: [],
      // This script makes no truth claims, so method checks are never forged
      // as "passed" when a template contains professional verification rules.
      ...(task.workMethod ? { methodChecks: task.workMethod.checks.map(check => ({
        checkId: check.id,
        status: 'unverified' as const,
        explanation: 'Assembly did not verify source accuracy or professional conclusions',
        evidenceRefs: []
      })) } : {})
    };
  }
};
