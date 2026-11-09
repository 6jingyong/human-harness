'use client';

import { affectedStepsForOutput, currentApprovedOutput, type ProjectState } from '@/core/runtime';

const materialStates: Record<string, string> = {
  requested: '等待提供', received: '待审核', accepted: '已接受', rejected: '退回补充',
  expected: '未来可能需要', dormant: '尚未启动', not_applicable: '不适用'
};

/**
 * File/semantic workspace is intentionally separate from the two-row Todo home.
 * Original file, template intent and reviewed Agent interpretation are distinct.
 */
export function ProjectMaterialLibrary({ project, onBack, onReplace, onRevise, values, feedback,
  files, onValue, onFeedback, onFile, isPending }: {
  project: ProjectState;
  onBack: () => void;
  onReplace: (materialId: string) => void;
  onRevise: (stepId: string, expectedArtifactId: string) => void;
  values: Record<string, string>;
  feedback: Record<string, string>;
  onFeedback: (id: string, value: string) => void;
  files: Record<string, File | undefined>;
  onValue: (id: string, value: string) => void;
  onFile: (id: string, file: File | undefined) => void;
  isPending: (id: string) => boolean;
}) {
  return <section className="library-page" aria-label="项目资料管理">
    <header className="library-heading">
      <button type="button" onClick={onBack}>← 返回 Todo</button>
      <div><span className="eyebrow">PROJECT LIBRARY</span><h1>项目资料</h1>
        <p>原件、模板对资料的要求和 Agent 的语义说明分别保存，不混为一份信息。</p></div>
    </header>
    <div className="library-meta">
      <div><strong>项目</strong><span>{project.title}</span></div>
      <div><strong>模板</strong><span>{project.package.title} · {project.templateVersion}</span></div>
      <div><strong>资料数</strong><span>{project.artifacts.filter(a => a.kind === 'material').length}</span></div>
    </div>
    <div className="library-items">
      {project.package.materials.map(def => {
        const state = project.materials[def.id];
        const versions = project.artifacts
          .filter(a => a.kind === 'material' && a.ownerId === def.id)
          .sort((a, b) => b.revision - a.revision);
        const linkedSteps = project.package.steps.filter(step =>
          step.needsMaterials.includes(def.id));
        const interpretations = linkedSteps.flatMap(step =>
          project.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === step.id)
            .sort((a, b) => b.revision - a.revision).map((artifact, index) => ({
              step, artifact, verified: currentApprovedOutput(project, step.id)?.id === artifact.id
            }))
        );
        const structured = interpretations.flatMap(({ step, artifact, verified }) =>
          (artifact.semanticNotes ?? []).filter(note => note.materialId === def.id)
            .map(note => ({ step, artifact, verified, note }))
        );
        const acceptedSourceId = state?.acceptedArtifactId ?? (state?.state === 'accepted' ? state.artifactIds.at(-1) : undefined);
        return <article className="library-material" key={def.id}>
          <header><div><h2>{def.title}</h2><small>{def.id}</small></div>
            <span className="task-state">{materialStates[state?.state] ?? '未知'}</span></header>
          <div className="library-section">
            <h3>原始资料</h3>
            {versions.map(artifact => <div className="library-file" key={artifact.id}>
              <div><strong>{artifact.name}</strong><small>版本 {artifact.revision} · {artifact.createdAt.slice(0, 10)}
                {acceptedSourceId === artifact.id && state.state === 'accepted'
                  ? ' · 当前接受版本' : ''}</small></div>
              {artifact.content && <details><summary>查看文字内容或上传说明</summary>
                <pre className="result">{artifact.content}</pre></details>}
              {artifact.name !== '用户文本说明' && <a href={'/api/v1/projects/' +
                encodeURIComponent(project.id) + '/materials/' + encodeURIComponent(artifact.id)}>
                保存原件
              </a>}
            </div>)}
            {!versions.length && <p className="muted">尚无资料文件。通过 Human Todo 按需提交。</p>}
            {state.state === 'accepted' && <details className="source-replacement">
              <summary>替换这份资料（新版本须重新验收）</summary>
              <p>原件通过验收后，依赖此资料的成果和后续审核会重新进入待处理状态；不相关分支不受影响。</p>
              {def.formats.includes('text/plain') && <>
                <label htmlFor={'replacement-text-' + def.id}>新的文字资料</label>
                <textarea id={'replacement-text-' + def.id} value={values[def.id] ?? ''}
                  onChange={event => onValue(def.id, event.target.value)} rows={3} />
              </>}
              {def.formats.length > 0 && <>
                <label htmlFor={'replacement-file-' + def.id}>选择新原件</label>
                <input id={'replacement-file-' + def.id} type="file"
                  accept={def.formats.join(',')}
                  onChange={event => onFile(def.id, event.target.files?.[0])} />
                {files[def.id] && <p>待提交：{files[def.id]?.name}</p>}
              </>}
              <button type="button" disabled={isPending(def.id) || (!files[def.id] && !(values[def.id] ?? '').trim())}
                onClick={() => onReplace(def.id)}>提交新版本，等待审核</button>
            </details>}
            {state.state === 'received' && <p className="source-revision">
              新资料等待验收。请返回 Human Todo 处理；审核通过前不会取代旧原件。
            </p>}
          </div>
          <div className="library-section">
            <h3>套用项目模板后的资料说明</h3>
            <p>{def.description}</p>
            {def.acceptance.length > 0 && <p className="muted">验收要求：{def.acceptance.join('；')}</p>}
            {def.method && <details className="template-analysis">
              <summary>查看模板的资料获取、信息提取与核验方法</summary>
              <p><strong>获取：</strong>{def.method.acquisition}</p>
              <p><strong>提取：</strong>{def.method.extraction}</p>
              <ul>{def.method.verification.map((rule, index) => <li key={index}>{rule}</li>)}</ul>
            </details>}
            {linkedSteps.map(step => <details className="template-analysis" key={step.id}>
              <summary>{step.title} · {project.steps[step.id]?.state ?? '未知状态'}</summary>
              <p>{step.instructions}</p>
            </details>)}
            {!linkedSteps.length && <p className="muted">模板暂未为该资料定义后续 Agent 处理步骤。</p>}
          </div>
          <div className="library-section semantic-section">
            <h3>Agent 语义说明</h3>
            {structured.map(({ step, artifact, verified, note }, index) =>
              <div className="semantic-note" key={artifact.id + ':' + index}>
                <div className="semantic-note-title">
                  <strong>{note.summary}</strong>
                  <span className="task-state">{verified && note.sourceArtifactId === acceptedSourceId
                    ? '已审核 · 当前原件' : verified ? '历史原件 / 旧版' : '候选待审'}</span>
                </div>
                <p>来源：{versions.find(source => source.id === note.sourceArtifactId)?.name ?? note.sourceArtifactId}
                  {' · v' + note.sourceRevision} · {note.location}</p>
                {note.caveat && <p>限制：{note.caveat}</p>}
                <small>来自任务：{step.title} / {artifact.name}</small>
              </div>)}
            {!structured.length && <p className="muted">
              暂无带来源引用的结构化语义记录；以下仅展示模板关联的 Agent 成果，不能自动视为逐条核实的事实。
            </p>}
            <h3 className="linked-output-title">相关 Agent 成果</h3>
            {interpretations.map(({ step, artifact, verified }) =>
              <details className="semantic-result" key={artifact.id}>
                <summary>{step.title} · v{artifact.revision}
                  <span>{verified ? '已审核' : '候选／未审核'}</span></summary>
                <p className="semantic-provenance">
                  本说明关联此资料，是因为项目模板将其列为该 Agent 任务的输入。
                  {verified ? ' 该任务已通过人工审核。' : ' 尚不能视为最终结论。'}
                </p>
                <pre className="result">{artifact.content}</pre>
                {verified && <a className="file-download" href={'/api/v1/projects/' +
                  encodeURIComponent(project.id) + '/outputs/' + encodeURIComponent(artifact.id)}>
                  下载已审核成果
                </a>}
              </details>)}
            {!interpretations.length && <p className="muted">
              暂无关联 Agent 结果。原件上传不会自动生成可信的语义信息。
            </p>}
          </div>
        </article>;
      })}
    </div>
    <section className="library-deliverables" aria-label="项目成果文件">
      <h2>项目成果文件</h2>
      <p className="muted">
        按模板输出契约统一汇总 A 的结果、B 的分析结论和 C 的最终成果。
        下游不需要为了在资料库中显示而重新读取原件。
      </p>
      {project.package.outputs.map(contract => {
        const producer = project.package.steps.find(step => step.id === contract.producingStepId);
        const artifacts = project.artifacts.filter(artifact =>
          artifact.kind === 'agent_output' && artifact.ownerId === contract.producingStepId)
          .sort((a, b) => b.revision - a.revision);
        const latest = artifacts[0];
        const head = currentApprovedOutput(project, contract.producingStepId);
        const accepted = Boolean(head);
        const revisionKey = 'revision:' + contract.producingStepId;
        const observedHeadKey = 'revision-head:' + contract.producingStepId;
        const expectedHead = values[observedHeadKey] || head?.id || '';
        const headChangedDuringEdit = Boolean(head && values[observedHeadKey] &&
          head.id !== expectedHead);
        const impact = affectedStepsForOutput(project, contract.producingStepId);
        const activeDependents = [...impact].filter(id =>
          ['running', 'waiting_input'].includes(project.steps[id]?.state));
        const changeText = values[revisionKey] ?? '';
        const changeReason = feedback[revisionKey] ?? '';
        return <details className="project-deliverable" key={contract.id}>
          <summary>{contract.title} · {contract.fileName}
            <span className="task-state">
              {accepted ? '已审核可下载' :
                latest ? latest.invalidatedAt ? '旧版已失效' : '候选待审核' : '尚未生成'}
            </span>
          </summary>
          <p>产出任务：{producer?.title ?? contract.producingStepId}</p>
          <p>格式：{contract.format.toUpperCase()} · 验收要求：{contract.acceptance.join('；')}</p>
          {latest && <pre className="result">{latest.content}</pre>}
          {head && <p className="source-revision">
            当前有效版本 HEAD：v{head.revision} · {head.id.slice(0, 8)}
            {head.humanCorrection ? ' · 人工修订采用' : ' · 已批准采用'}
          </p>}
          {head && ['markdown', 'json'].includes(contract.format) &&
            <a className="file-download" href={'/api/v1/projects/' +
              encodeURIComponent(project.id) + '/outputs/' + encodeURIComponent(head.id)}>
              下载已审核成果
            </a>}
          {artifacts.length > 1 && <details className="source-replacement">
            <summary>查看完整历史版本（{artifacts.length}）</summary>
            {artifacts.map(a => <div key={a.id} className="library-file">
              <p>v{a.revision} · {a.createdAt.slice(0, 19).replace('T', ' ')}
                {head?.id === a.id ? ' · HEAD' : ''}
                {a.invalidatedAt ? ' · 已失效' : ''}</p>
              {a.humanCorrection && <p>人类修订：{a.humanCorrection.rationale}
                （基于 {a.humanCorrection.basedOnArtifactId.slice(0, 8)}）</p>}
              {a.inputArtifactIds?.length ? <p>输入版本：{a.inputArtifactIds.join('、')}</p> : null}
              <pre className="result">{a.content}</pre>
              {head && a.id !== head.id && <button type="button"
                onClick={() => {
                  onValue(observedHeadKey, head.id);
                  onValue(revisionKey, a.content ?? '');
                }}>
                将此版本内容复制到修订区（恢复时也会产生新版本）
              </button>}
            </div>)}
          </details>}
          {head && ['json', 'markdown'].includes(contract.format) && <details className="source-replacement">
            <summary>人类修订当前已批准成果（保留所有历史）</summary>
            <p>人类拥有最终采用权。修订会创建新版本，不会改变旧版。原 Agent 的自检不自动继承。</p>
            <p>预计影响后继任务 {impact.size} 项：{[...impact].map(id =>
              project.package.steps.find(step => step.id === id)?.title ?? id).join('、') || '无'}</p>
            {activeDependents.length > 0 && <p className="error-text">
              当前有 {activeDependents.length} 项下游任务正在运行或等待补充信息。须先完成或取消，不能静默覆盖其输入。
            </p>}
            <button type="button" onClick={() => {
              onValue(observedHeadKey, head.id);
              onValue(revisionKey, head.content ?? '');
            }}>
              复制当前 HEAD 到编辑区
            </button>
            <label htmlFor={'result-revision-' + contract.producingStepId}>新的完整成果内容</label>
            <textarea id={'result-revision-' + contract.producingStepId}
              rows={8} value={changeText}
              onChange={event => {
                if (!values[observedHeadKey]) onValue(observedHeadKey, head.id);
                onValue(revisionKey, event.target.value);
              }} />
            <label htmlFor={'revision-reason-' + contract.producingStepId}>修改或恢复原因（必填）</label>
            <textarea id={'revision-reason-' + contract.producingStepId}
              rows={3} value={changeReason}
              onChange={event => onFeedback(revisionKey, event.target.value)} />
            <p className="muted">编辑基于 HEAD {expectedHead.slice(0, 8)}。提交时会核对该版本是否仍有效，并按依赖关系重新开放受影响任务。</p>
            {headChangedDuringEdit && <p className="error-text">
              当前 HEAD 已更新，请重新查看并复制最新版本后再修订；旧稿不会被静默套用到新版本。
            </p>}
            <button type="button" className="primary"
              disabled={isPending(revisionKey) || activeDependents.length > 0 ||
                headChangedDuringEdit || !changeText.trim() || !changeReason.trim() ||
                changeText.trim() === head.content?.trim()}
              onClick={() => onRevise(contract.producingStepId, expectedHead)}>
              记录修订、更新 HEAD 并重开受影响任务
            </button>
          </details>}
        </details>;
      })}
    </section>
    <details className="library-events">
      <summary>项目操作记录（{project.events.length}）</summary>
      {project.events.slice(-30).reverse().map(event => <div key={event.id}>
        <time>{event.createdAt.slice(0, 19).replace('T', ' ')}</time>
        <strong>{event.type}</strong><span>{event.subject}</span>
      </div>)}
    </details>
  </section>;
}
