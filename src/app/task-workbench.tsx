'use client';

import type { ProjectState } from '@/core/runtime';
import { deriveWorkbenchQueues, groupAgentTasks, type WorkbenchItem } from './workbench-queue';

const stepStates: Record<string, string> = {
  dormant: '未来阶段', blocked: '等待依赖', ready: '可执行', running: '执行中',
  waiting_input: '等待人工补充', review: '等待人工审核', done: '已完成', not_applicable: '不适用', failed: '执行失败'
};
const materialStates: Record<string, string> = {
  requested: '待提交', received: '待核验', accepted: '已接受', rejected: '已退回',
  dormant: '未来阶段', expected: '尚未需要', not_applicable: '不适用'
};
type ActionOptions = { stepId?: string; materialId?: string; requestId?: string };

type Props = {
  project: ProjectState;
  executor: string;
  selectedKey: string;
  onSelect: (key: string) => void;
  onRefresh: () => void;
  onAction: (name: string, options: ActionOptions) => void;
  values: Record<string, string>;
  feedback: Record<string, string>;
  files: Record<string, File | undefined>;
  onValue: (key: string, value: string) => void;
  onFeedback: (key: string, value: string) => void;
  onFile: (key: string, value: File | undefined) => void;
  isPending: (key: string) => boolean;
};

function TaskOption({ item, selected, onSelect }: {
  item: WorkbenchItem; selected: boolean; onSelect: (key: string) => void;
}) {
  const label = item.kind === 'request' ? ({ pending: '需要答复', awaiting_review: '附件待验收', answered: '已答复' }[item.state] ?? item.state) :
    item.kind === 'material' ? materialStates[item.state] : stepStates[item.state];
  return <button type="button" className={'workbench-item' + (selected ? ' selected' : '')}
    aria-pressed={selected} onClick={() => onSelect(item.key)} key={item.key}>
    <span className="workbench-item-label">{item.title}</span>
    <span className={'task-state ' + item.state}>{label ?? item.state}</span>
  </button>;
}

export function TaskWorkbench({
  project, executor, selectedKey, onSelect, onRefresh, onAction,
  values, feedback, files, onValue, onFeedback, onFile, isPending
}: Props) {
  const queues = deriveWorkbenchQueues(project);
  const agentGroups = groupAgentTasks(project, queues.agent);
  const current = selectedKey ?
    [...queues.human, ...queues.agent].find(item => item.key === selectedKey) : undefined;
  const material = current?.kind === 'material'
    ? project.package.materials.find(m => m.id === current.id) : undefined;
  const step = current?.kind === 'agent' || current?.kind === 'human'
    ? project.package.steps.find(s => s.id === current.id) : undefined;
  const humanRequest = current?.kind === 'request'
    ? project.humanRequests?.find(request => request.id === current.id) : undefined;
  const currentMaterialState = material ? project.materials[material.id] : undefined;
  const requestMaterial = humanRequest ? project.package.materials.find(m => m.id === humanRequest.materialId) : undefined;
  const canUploadRequestedMaterial = humanRequest && ['requested', 'rejected', 'accepted']
    .includes(project.materials[humanRequest.materialId]?.state ?? '');
  const requestUpload = humanRequest?.attachmentArtifactId ?
    project.artifacts.find(a => a.id === humanRequest.attachmentArtifactId) : undefined;
  const currentStepState = step ? project.steps[step.id] : undefined;
  const key = current?.id ?? '';
  const disabled = isPending(key);
  const pending = values[key] ?? '';
  const note = feedback[key] ?? '';
  const activeRun = step ? project.runs.filter(run => run.stepId === step.id).at(-1) : undefined;
  const outputRevisions = step
    ? project.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === step.id).reverse()
    : [];
  const lastUpload = material && currentMaterialState
    ? project.artifacts.find(a => a.id === currentMaterialState.artifactIds.at(-1))
    : undefined;
  const stepHistory = step ? project.events.filter(e =>
    e.subject === step.id &&
    ['human.completed', 'decision.approved', 'external.confirmed', 'work.approved'].includes(e.type)
  ).at(-1) : undefined;
  const policy = project.execution ?? { autoDispatch: false, maxParallel: 2 };

  return <section className="todo-home" aria-label="Human Harness 任务工作台">
    <div className="todo-columns">
      <section className="todo-column" aria-label="人类 TodoList">
        <header className="todo-column-heading"><h2>Human TodoList</h2><small>{queues.human.length} 项待处理</small></header>
        <div className="todo-vertical-list">
          {queues.human.map(item => <TaskOption key={item.key} item={item}
            selected={current?.key === item.key}
            onSelect={key => onSelect(selectedKey === key ? '' : key)} />)}
          {!queues.human.length && <p className="todo-empty">当前无需人工处理</p>}
        </div>
      </section>
      <section className="todo-column" aria-label="Agent TodoList">
        <header className="todo-column-heading"><h2>Agent TodoList</h2><small>{queues.agent.length} 项任务</small></header>
        <div className="agent-folders">
          {agentGroups.map(group => <details className="agent-folder" key={group.id} open>
            <summary><span>{group.title}</span><small>{group.tasks.length}</small></summary>
            <div className="agent-folder-content">
              {(['running', 'ready', 'waiting_input', 'failed', 'blocked'] as const).map(state => {
                const tasks = group.tasks.filter(item => item.state === state);
                if (!tasks.length) return null;
                const label = { running: '运行中', ready: '待执行', waiting_input: '等待人工答复', failed: '执行失败', blocked: '等待依赖' }[state];
                return <details className="agent-state-folder" key={state} open={state !== 'blocked'}>
                  <summary><span>{label}</span><small>{tasks.length}</small></summary>
                  <div className="todo-vertical-list">
                    {tasks.map(item => <TaskOption key={item.key} item={item}
                      selected={current?.key === item.key}
                      onSelect={key => onSelect(selectedKey === key ? '' : key)} />)}
                  </div>
                </details>;
              })}
            </div>
          </details>)}
          {!agentGroups.length && <p className="todo-empty">当前没有待处理的 Agent 任务</p>}
        </div>
      </section>
    </div>
    {current && <div className="todo-detail-wrap">
      <div className="todo-detail-top"><span>任务详情</span>
        <button type="button" onClick={() => onSelect('')} aria-label="关闭任务详情">× 关闭</button>
      </div>
      <article className="workbench-inspector" aria-label="选中任务操作">
        {!current ? <div className="workbench-empty">
          <h3>当前没有需要操作的任务</h3>
          <p>后续步骤将由项目模板的依赖关系决定。可以查看下方未来资料与事件记录。</p>
        </div> : <>
          <div className="workbench-inspector-header">
            <span className="eyebrow">{material ? 'MATERIAL HANDOFF' :
              step?.kind === 'agent' || step?.kind === 'script' ? 'AGENT WORK ITEM' : 'HUMAN WORK ITEM'}</span>
            <span className={'task-state ' + current.state}>
              {(current.kind === 'request' ? { pending: '需要答复', awaiting_review: '附件待验收', answered: '已答复' } :
                material ? materialStates : stepStates)[current.state] ?? current.state}
            </span>
          </div>
          <h2>{current.title}</h2>
          <p className="task-instructions">{material?.description ?? step?.instructions ?? humanRequest?.reason}</p>
          <div className="task-context-grid">
            <div><strong>任务编号</strong><span>{current.id}</span></div>
            <div><strong>负责方</strong><span>{current.owner === 'history' ? '已完成' :
              current.owner === 'human' ? '人类' : 'Agent'}</span></div>
          </div>
          {humanRequest && <section className="inspector-section">
            <h3>Agent 请求补充信息</h3>
            <p>相关资料：{requestMaterial?.title ?? humanRequest.materialId}</p>
            <p>问题：{humanRequest.reason}</p>
            {humanRequest.status === 'pending' && <>
              <p className="muted">可以填写说明。若提供新的原件，必须先经过资料验收；仅提交文字不会自动改变已核验文件。</p>
              <label htmlFor={'human-request-' + key}>你的回复／来源说明</label>
              <textarea id={'human-request-' + key} rows={4} value={pending}
                onChange={event => onValue(key, event.target.value)}
                placeholder="补充信息，或说明暂时无法取得" />
              {canUploadRequestedMaterial && requestMaterial?.formats.some(format => format !== 'text/plain') && <>
                <label htmlFor={'human-request-file-' + key}>补充原始文件（选填，须人工验收）</label>
                <input id={'human-request-file-' + key} type="file"
                  accept={requestMaterial.formats.filter(format => format !== 'text/plain').join(',')}
                  onChange={event => onFile(key, event.target.files?.[0])} />
                {files[key] && <p className="muted">待提交：{files[key]?.name}</p>}
              </>}
              {!canUploadRequestedMaterial && <p className="muted">
                模板尚未开放此资料类型的原件收集；可先填写说明，或等待项目进入相应的资料阶段。
              </p>}
              <button type="button" className="primary" disabled={disabled || (!pending.trim() && !files[key])}
                onClick={() => onAction('answer_human_request', { requestId: key })}>
                {files[key] ? '提交原件，等待资料验收' : '提交说明并继续 Agent'}
              </button>
            </>}
            {humanRequest.status === 'awaiting_review' && <>
              <p className="source-revision">已提交：{requestUpload?.name ?? '原始文件'} · v{requestUpload?.revision ?? '?'}，尚未验收。</p>
              <label htmlFor={'human-request-review-' + key}>资料验收意见（退回时必填）</label>
              <textarea id={'human-request-review-' + key} rows={3} value={note}
                onChange={event => onFeedback(key, event.target.value)}
                placeholder="检查来源与版本；不合格时填写退回原因" />
              <div className="actions">
                <button type="button" className="primary" disabled={disabled}
                  onClick={() => onAction('accept_material', { materialId: humanRequest.materialId })}>
                  验收原件并继续 Agent
                </button>
                <button type="button" disabled={disabled || !note.trim()}
                  onClick={() => onAction('reject_material', { materialId: humanRequest.materialId })}>退回补充文件</button>
              </div>
            </>}
          </section>}
          {material && currentMaterialState && <>
            <section className="inspector-section">
              <h3>资料要求与验收</h3>
              <p>允许格式：{material.formats.join(' / ')}</p>
              <ul>{material.acceptance.map(rule => <li key={rule}>{rule}</li>)}</ul>
              {lastUpload && <p className="source-revision">
                最近提交：{lastUpload.name}（v{lastUpload.revision}）
              </p>}
            </section>
            {current.state === 'received' && <section className="inspector-section">
              <h3>核验收到的材料</h3>
              {lastUpload?.content && <pre className="result">{lastUpload.content}</pre>}
              <label htmlFor={'material-review-' + key}>审核说明（退回时必填）</label>
              <textarea id={'material-review-' + key} value={note}
                onChange={event => onFeedback(key, event.target.value)}
                placeholder="记录来源、质量问题或退回原因" />
              <div className="actions">
                <button type="button" className="primary" disabled={disabled}
                  onClick={() => onAction('accept_material', { materialId: key })}>确认接受材料</button>
                <button type="button" disabled={disabled || !note.trim()}
                  onClick={() => onAction('reject_material', { materialId: key })}>退回补充</button>
              </div>
            </section>}
            {(current.state === 'requested' || current.state === 'rejected') &&
              <section className="inspector-section">
                <h3>{current.state === 'rejected' ? '重新提交材料' : '提交材料'}</h3>
                {current.state === 'rejected' && <p className="error-text">上一版本已退回，请按验收要求补充。</p>}
                {material.formats.includes('text/plain') && <>
                  <label htmlFor={'material-text-' + key}>资料内容 / 来源说明</label>
                  <textarea id={'material-text-' + key} rows={5} value={pending}
                    onChange={event => onValue(key, event.target.value)}
                    placeholder="填写可供 Agent 使用的真实内容及来源" />
                </>}
                {material.formats.some(format => format !== 'text/plain') && <>
                  <label htmlFor={'material-file-' + key}>原始文件</label>
                  <input id={'material-file-' + key} type="file"
                    accept={material.formats.filter(format => format !== 'text/plain').join(',')}
                    onChange={event => onFile(key, event.target.files?.[0])} />
                  {files[key] && <p className="muted">待上传：{files[key]?.name}</p>}
                </>}
                <button type="button" className="primary" disabled={disabled ||
                  (!files[key] && !pending.trim())} onClick={() => onAction('submit_material', { materialId: key })}>
                  提交资料，等待人工核验
                </button>
              </section>}
            {current.state === 'accepted' && <p className="inspector-success">资料已接受，后续 Agent 只能读取经授权的版本。</p>}
          </>}
          {step && currentStepState && <>
            {(step.dependsOn.length > 0 || step.needsMaterials.length > 0) &&
              <section className="inspector-section">
                <h3>依赖与输入</h3>
                {step.dependsOn.map(id => <div className="requirement-line" key={'step-' + id}>
                  <span>{project.package.steps.find(def => def.id === id)?.title ?? id}</span>
                  <span>{stepStates[project.steps[id]?.state] ?? '未知'}</span>
                </div>)}
                {step.needsMaterials.map(id => <div className="requirement-line" key={'material-' + id}>
                  <span>{project.package.materials.find(def => def.id === id)?.title ?? id}</span>
                  <span>{materialStates[project.materials[id]?.state] ?? '未知'}</span>
                </div>)}
              </section>}
            {step.kind === 'human_decision' && currentStepState.state === 'ready' &&
              <section className="inspector-section">
                <h3>作出决策</h3>
                <label htmlFor={'choice-' + key}>选择正式决定</label>
                <select id={'choice-' + key} value={pending} onChange={event => onValue(key, event.target.value)}>
                  <option value="">请选择</option>
                  {step.options?.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}
                </select>
                <button type="button" className="primary" disabled={disabled || !pending.trim()}
                  onClick={() => onAction('complete_human', { stepId: key })}>确认决定并继续</button>
              </section>}
            {(step.kind === 'human_action' || step.kind === 'external_milestone') &&
              currentStepState.state === 'ready' &&
              <section className="inspector-section">
                <h3>提交人工执行结果</h3>
                <label htmlFor={'human-result-' + key}>完成情况、结论或交接给 Agent 的信息</label>
                <textarea rows={6} id={'human-result-' + key} value={pending}
                  onChange={event => onValue(key, event.target.value)}
                  placeholder="说明已执行的事项和可供下一步使用的真实信息" />
                <button type="button" className="primary" disabled={disabled || !pending.trim()}
                  onClick={() => onAction('complete_human', { stepId: key })}>确认完成并交接</button>
              </section>}
            {(step.kind === 'agent' || step.kind === 'script') && <>
              {currentStepState.state === 'ready' && <section className="inspector-section">
                <h3>准备执行</h3>
                {policy.autoDispatch ? <p className="dispatch-hint">已进入自动派发队列，满足资源与依赖条件后执行。</p> :
                  <button type="button" className="primary" disabled={disabled}
                    onClick={() => onAction('run_agent', { stepId: key })}>手动执行该任务</button>}
              </section>}
              {currentStepState.state === 'running' && <section className="inspector-section">
                <h3>Agent 正在工作</h3>
                <p className="dispatch-hint">运行独立于当前页面，人工待办仍可处理。</p>
                {activeRun && <p className="run-detail">Run {activeRun.id.slice(0, 8)}
                  {activeRun.codexTurnId ? ' · Codex turn ' + activeRun.codexTurnId : ''}
                  {activeRun.lastExecutorEvent ? ' · ' + activeRun.lastExecutorEvent : ''}</p>}
                <button type="button" disabled={disabled}
                  onClick={() => onAction('cancel_agent', { stepId: key })}>取消这项 Agent 任务</button>
              </section>}
              {currentStepState.state === 'failed' && <section className="inspector-section">
                <h3>执行失败</h3>
                <p className="error-text">{activeRun?.error ?? '未记录失败详情'}</p>
                <button type="button" disabled={disabled} onClick={() => onAction('retry_agent', { stepId: key })}>
                  允许重新执行
                </button>
              </section>}
              {currentStepState.state === 'blocked' && <p className="dispatch-hint">上游成果或资料尚未满足，暂不能执行。</p>}
              {currentStepState.state === 'waiting_input' && <p className="dispatch-hint">已暂停：等待左侧 Human Todo 的补充信息。全部回复后重新进入待执行队列；如自动派发已暂停，可以手动执行。</p>}
              {outputRevisions.length > 0 && <section className="inspector-section">
                <h3>候选成果与历史版本</h3>
                {outputRevisions.map((artifact, index) =>
                  <details key={artifact.id} className="output" open={index === 0}>
                    <summary>v{artifact.revision} · {artifact.name}{index === 0 ? '（最新）' : ''}</summary>
                    {currentStepState.state === 'done' && index === 0 &&
                      <a className="file-download" href={'/api/v1/projects/' +
                        encodeURIComponent(project.id) + '/outputs/' + encodeURIComponent(artifact.id)}>
                        下载已审核成果
                      </a>}
                    <pre className="result">{artifact.content}</pre>
                  </details>)}
              </section>}
              {currentStepState.state === 'review' && <section className="inspector-section approval-section">
                <h3>审核 Agent 候选结果</h3>
                <p>批准后才会解除依赖并推进后续任务；退回必须说明原因。</p>
                <label htmlFor={'agent-review-' + key}>审核说明</label>
                <textarea id={'agent-review-' + key} value={note}
                  onChange={event => onFeedback(key, event.target.value)}
                  placeholder="记录修改意见或不符合验收条件的原因" />
                <div className="actions">
                  <button type="button" className="primary" disabled={disabled}
                    onClick={() => onAction('approve_agent', { stepId: key })}>批准并交接下游</button>
                  <button type="button" disabled={disabled || !note.trim()}
                    onClick={() => onAction('reject_agent', { stepId: key })}>退回 Agent 重做</button>
                </div>
              </section>}
            </>}
            {currentStepState.state === 'done' && <section className="inspector-section">
              <h3>已完成</h3>
              <p className="inspector-success">该步骤已完成。后续任务根据项目依赖独立推进。</p>
              {stepHistory?.detail && <p>确认记录：{stepHistory.detail}</p>}
            </section>}
          </>}
        </>}
      </article>
    </div>}
  </section>;
}
