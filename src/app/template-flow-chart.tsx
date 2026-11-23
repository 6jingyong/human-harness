'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flowTaskLabels, type FlowLink, type FlowNode } from '@/protocol/template-flow';

type ChartProps = {
  nodes: FlowNode[];
  links: FlowLink[];
  selected: string;
  onSelect: (node: FlowNode) => void;
};

export function TemplateFlowChart({ nodes, links, selected, onSelect }: ChartProps) {
  const canvas = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ d: string; rule: FlowLink['rule'] }[]>([]);
  const rows = useMemo(() => {
    const byDepth = new Map<number, Record<FlowNode['lane'], FlowNode[]>>();
    for (const node of nodes) {
      const lanes = byDepth.get(node.depth) ?? { human: [], machine: [] };
      lanes[node.lane].push(node);
      byDepth.set(node.depth, lanes);
    }
    return [...byDepth.entries()].sort(([a], [b]) => a - b);
  }, [nodes]);
  const drawn = useMemo(() => {
    const keys = new Set(nodes.map(item => item.key));
    return links.filter(edge => keys.has(edge.from) && keys.has(edge.to) &&
      (nodes.length <= 14 || edge.to === selected || edge.from === selected));
  }, [nodes, links, selected]);
  const related = useMemo(() => new Set(links.flatMap(edge =>
    edge.from === selected ? [edge.to] : edge.to === selected ? [edge.from] : [])), [links, selected]);

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const origin = element.getBoundingClientRect();
      const boxes = new Map([...element.querySelectorAll<HTMLElement>('[data-flow-card]')].map(card => {
        const right = card.dataset.lane === 'human';
        const bounds = card.getBoundingClientRect();
        return [card.dataset.flowCard, { right, x: (right ? bounds.right : bounds.left) - origin.left,
          y: bounds.top + bounds.height / 2 - origin.top }] as const;
      }));
      setPaths(drawn.flatMap((edge, index) => {
        const source = boxes.get(edge.from), target = boxes.get(edge.to);
        if (!source || !target) return [];
        const centralX = origin.width / 2 + (index % 5 - 2) * 3;
        const endX = target.x + (target.right ? 5 : -5);
        return [{ d: 'M ' + source.x + ' ' + source.y + ' H ' + centralX + ' V ' + target.y + ' H ' + endX, rule: edge.rule }];
      }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [drawn, rows]);

  return <section className="flow-chart" aria-label="项目双轴流程图">
    <div className="flow-lanes">
      <h2><span className="flow-dot human" />必须由人完成</h2>
      <h2><span className="flow-dot machine" />可交给 AI／程序</h2>
    </div>
    <div className="flow-scroll">
      <div className="flow-canvas" ref={canvas}>
        <svg className="flow-arrows" width="100%" height="100%" aria-hidden="true">
          <defs><marker id="flow-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M 0 0 L 6 3 L 0 6 z" fill="#839fbc" />
          </marker></defs>
          {paths.map((path, index) => <path key={index} d={path.d} className={path.rule} markerEnd="url(#flow-arrowhead)" />)}
        </svg>
        {rows.map(([depth, lanes]) => <div className="flow-row" key={depth}>
          {(['human', 'machine'] as const).map(lane => <div className="flow-lane" key={lane}>
            {lanes[lane].map(node => <button key={node.key} type="button" data-flow-card={node.key}
              data-lane={lane} aria-pressed={node.key === selected} onClick={() => onSelect(node)}
              className={'flow-card ' + lane + (node.key === selected ? ' selected' : related.has(node.key) ? ' related' : '')}>
              <small>{flowTaskLabels[node.kind]}</small>
              <strong>{node.title || '未命名任务'}</strong>
            </button>)}
          </div>)}
        </div>)}
        {!nodes.length && <p className="flow-empty">这一视图没有任务。可以新增任务或切换阶段。</p>}
      </div>
    </div>
    <div className="flow-legend"><span><i /> 完成或交接</span><span><i /> 条件触发</span>
      {nodes.length > 14 && <span>点击任务查看前后连线</span>}
    </div>
  </section>;
}
