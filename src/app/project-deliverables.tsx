'use client';

import { currentApprovedOutput, type ProjectState } from '@/core/runtime';
import { templateDeliverables } from '@/protocol/project-launch';

export function ProjectDeliverables({ project, onOpen }: {
  project: ProjectState;
  onOpen: (key: string) => void;
}) {
  const active = templateDeliverables(project.package)
    .filter(contract => project.steps[contract.producingStepId]?.state !== 'not_applicable');
  if (!active.length) return null;

  return <section className="project-delivery" aria-label="项目交付">
    <h2>项目交付</h2>
    <ul>{active.map(contract => {
      const state = project.steps[contract.producingStepId]?.state;
      const artifact = currentApprovedOutput(project, contract.producingStepId);
      const download = artifact && '/api/v1/projects/' + encodeURIComponent(project.id) +
        '/outputs/' + encodeURIComponent(artifact.id);
      return <li key={contract.id}>
        <span>{contract.title}{artifact ? ' · 已验收' : state === 'dormant' ? ' · 待确定路线'
          : state === 'review' ? ' · 待验收' : ' · 待交付'}</span>
        {download ? <div className="delivery-downloads">
          <a className="file-download" href={download}>{contract.word ? '下载 Markdown' : '下载交付件'}</a>
          {contract.word && <a className="file-download" href={download + '?format=docx'}>下载 Word</a>}
        </div> : state === 'review' && <button type="button"
          onClick={() => onOpen('step:' + contract.producingStepId)}>打开验收待办</button>}
      </li>;
    })}</ul>
  </section>;
}
