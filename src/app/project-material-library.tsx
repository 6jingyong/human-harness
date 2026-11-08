'use client';

import type { ProjectState } from '@/core/runtime';

const materialStates: Record<string, string> = {
  requested: '等待提供', received: '待审核', accepted: '已接受', rejected: '退回补充',
  expected: '未来可能需要', dormant: '尚未启动', not_applicable: '不适用'
};

/**
 * File/semantic workspace is intentionally separate from the two-row Todo home.
 * Original file, template intent and reviewed Agent interpretation are distinct.
 */
export function ProjectMaterialLibrary({ project, onBack, onReplace, values, files, onValue, onFile, isPending }: {
  project: ProjectState;
  onBack: () => void;
  onReplace: (materialId: string) => void;
  values: Record<string, string>;
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
              step, artifact, verified: index === 0 && !artifact.invalidatedAt && project.steps[step.id]?.state === 'done'
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
              {def.formats.some(format => format !== 'text/plain') && <>
                <label htmlFor={'replacement-file-' + def.id}>选择新原件</label>
                <input id={'replacement-file-' + def.id} type="file"
                  accept={def.formats.filter(format => format !== 'text/plain').join(',')}
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
    <details className="library-events">
      <summary>项目操作记录（{project.events.length}）</summary>
      {project.events.slice(-30).reverse().map(event => <div key={event.id}>
        <time>{event.createdAt.slice(0, 19).replace('T', ' ')}</time>
        <strong>{event.type}</strong><span>{event.subject}</span>
      </div>)}
    </details>
  </section>;
}
