import { readFileSync, writeFileSync } from 'node:fs';

const local = name => new URL(name, import.meta.url);
const profile = JSON.parse(readFileSync(local('report-profile.json'), 'utf8'));
const materials = JSON.parse(readFileSync(local('materials.json'), 'utf8'));
const outputPath = local('land-investigation.hh.json');
const sampling = { type: 'decision', stepId: 'investigation-route', option: 'sampling' };
const preliminary = { ...sampling, option: 'preliminary' };

const stages = [
  { id: 'collect', title: '收集素材', description: '核验项目来源，按原始资料种类提取已有结果和来源结论。' },
  { id: 'organize', title: '整理素材', description: '整理可复用项目成果；由专业人员选择阶段和审核对外工作；条件成立后再整理采样及检测资料。' },
  { id: 'draft', title: '成文与目录', description: '目录与分析分开核对，正文按已审核成果和当前目录分节完成。' },
  { id: 'deliver', title: '审核与组装', description: '按目录顺序组装已审核小节，提交内部审阅。' }
];
const agents = [
  { id: 'source', title: '素材提取', description: '从本任务原始资料读取可追溯的字段。' },
  { id: 'results', title: '成果整理', description: '合并摘录、保留来源和口径，编制项目成果。' },
  { id: 'analysis', title: '项目分析', description: '按授权范围对已确认成果形成可核对的分析。' },
  { id: 'outline', title: '目录整理', description: '审核固定目录和需要按对象展开的动态标题。' },
  { id: 'writing', title: '分节成文', description: '根据确认成果、目录及职责写作。' },
  { id: 'delivery', title: '报告组装', description: '按章节顺序组装已审核文本。' }
];
const capabilities = [
  { id: 'mastra.agent', kind: 'agent', description: '使用 Human Harness 当前配置的 Agent 执行器。' },
  { id: 'hh.render.markdown', kind: 'script', description: '确定性组装已审核的 Markdown 小节。' }
];
const workOrders = [
  { id: 'land-survey', title: '外包地测', description: '在要求日期前取得并验收地测成果。先联系机构并核对档期，再由本人确认委托与实际回件。',
    deliverables: ['survey-result'], consumers: ['extract-project'],
    followUp: { milestoneId: 'survey-return', workingDays: 1 } },
  { id: 'government-archive', title: '政府调档', description: '在要求日期前取得并核验政府保存的项目报告或正式答复，由本人办理和跟进。',
    deliverables: ['government-record'], consumers: ['extract-history'],
    followUp: { milestoneId: 'archive-return', workingDays: 2 } }
];
const steps = [];
const outputs = [];

function addCandidate({
  id, title, instructions, stageId, agentId, dependsOn = [], needsMaterials = [],
  when, format = 'json', acceptance, markdown, word, askForSource = false, script = false
}) {
  const outputId = id + '-output';
  steps.push({
    id, title, instructions, stageId, agentId, dependsOn, needsMaterials,
    ...(when ? { when } : {}),
    ...(askForSource ? { requestableMaterialIds: ['clarification'] } : {}),
    kind: script ? 'script' : 'agent',
    capabilityId: script ? 'hh.render.markdown' : 'mastra.agent',
    requiresReview: true,
    planning: agentId === 'writing' ? { workMinutes: 60, reviewMinutes: 45 } :
      script ? { workMinutes: 30, reviewMinutes: 90 } : { workMinutes: 60, reviewMinutes: 30 },
    outputContractId: outputId
  });
  outputs.push({
    id: outputId, title, format, audience: 'internal', fileName: id + (format === 'json' ? '.json' : '.md'),
    producingStepId: id, acceptance, humanSignoff: true,
    ...(markdown ? { markdown } : {}),
    ...(word ? { word } : {}),
    ...(script ? { deliverable: true } : {})
  });
}

function addHuman(id, title, instructions, dependsOn, kind, when, options) {
  steps.push({
    id, title, instructions, dependsOn, kind, stageId: 'organize', needsMaterials: [],
    planning: { workMinutes: kind === 'external_milestone' ? 2400 : 60 },
    ...(when ? { when } : {}),
    ...(options ? { options } : {})
  });
}

function orderStep(orderId, id, title, instructions, dependsOn, workMinutes, kind = 'human_action', needsMaterials = []) {
  steps.push({ id, title, instructions, dependsOn, kind, stageId: 'collect', needsMaterials,
    when: { type: 'work_order', orderId }, planning: { workMinutes } });
}
orderStep('land-survey', 'survey-contact', '提前联系地测机构',
  '联系具备相应能力的机构，说明项目位置、需求和期望交付日。记录机构、联系人、报价及对方给出的档期。', [], 30);
orderStep('land-survey', 'survey-book', '核对地测档期并确认委托',
  '核对作业范围、进场时间、交付日和成果格式。实际完成委托后记录凭据、联系人和约定回件时间。',
  ['survey-contact'], 30, 'human_action', ['project-identity']);
orderStep('land-survey', 'survey-return', '核实地测机构回件',
  '等待实际回件。跟进时记下回复与新的交期。只有拿到实际成果后才确认回件，随后提交原件验收。',
  ['survey-book'], 960, 'external_milestone');
orderStep('government-archive', 'archive-access', '确认调档机关与办理材料',
  '确认保管机关、档案线索、所需授权及办理方式。记录经核对的办理窗口和凭据。', [], 30);
orderStep('government-archive', 'archive-apply', '本人向政府申请调取报告',
  '提交实际调档申请，记录受理编号、办理窗口与预计答复时间。',
  ['archive-access'], 60, 'human_action', ['project-identity']);
orderStep('government-archive', 'archive-return', '跟进政府答复并核实取得情况',
  '在约定日期核对答复。收到报告或可核验的正式答复后确认，随后提交原件验收。',
  ['archive-apply'], 1440, 'external_milestone');

const extractAcceptance = [
  '每条原值、原文结论、图表登记和来源位置可追溯',
  '区分原始观察、来源自己的结论、手工说明及项目分析',
  '未读页、缺失或冲突记录独立列明，保持原样品编号、单位和 ND'
];
function extract(id, title, needsMaterials, subjects, when, dependsOn = []) {
  addCandidate({
    id, title, needsMaterials, when, dependsOn, stageId: 'collect', agentId: 'source', askForSource: true,
    instructions: [
      '读取本任务已接收并经审核的资料，整理来源字段和原文结论。范围为' + subjects + '。',
      '返回 JSON 对象，区分 items、displaySources、gaps。各项列出稳定标识、原资料编号或授权 artifactId、版本、页码或表行、原值/原文、对象、时点、单位、适用边界。图件记录原文件、来源位置、使用范围和图题。',
      '保留 ND、原样/平行样、对照/地块内及计划/实际的区别。阅读、比对及 OCR 属于候选处理，项目专业结论由后续任务和人工确认。补件问题应说明具体证据为何确实缺失。'
    ].join('\n'),
    acceptance: extractAcceptance
  });
}
extract('extract-project', '提取项目身份、边界和规划依据', ['project-identity', 'boundary', 'land-use'],
  '地块识别、范围、面积、坐标系、规定依据、规划用途，以及已启用的地测成果');
extract('extract-history', '提取地块历史、企业活动和周边环境', ['desk-records'],
  '历史沿革、企业及活动、相邻地块与迁移通道、地质水文、敏感目标，以及已启用的政府调档回件');
extract('extract-visit', '提取踏勘、访谈和图件登记', ['site-visit'],
  '现场记录、人员访谈、图件的来源、时点和适用范围');

const resultAcceptance = [
  '采用成果保留可回放的来源、方法、对象及适用边界',
  '已有结论与实测结果分别标明，缺口和不适用依据保留在成果账',
  '表格保留原始行列和单位；图件优先已核对的原件'
];
function organize(id, title, dependsOn, focus, when) {
  addCandidate({
    id, title, dependsOn, when, stageId: 'organize', agentId: 'results',
    instructions: [
      '仅从已审核提取结果和交接内容形成项目成果。范围为' + focus + '。',
      '返回 results、sourceConclusions、tableBindings、figureBindings、gaps、exclusions。成果和图表给持久 ID，保留每项输入与来源版本定位、单位及适用边界。每项输入或纳入候选、或明确缺口、或说明不采用理由。',
      '把已确认原表与原值关联到适用表位，查找已核对素材图，记录各图位的原件编号、版本、出处和图题。若仅拿到来源索引或图件未获审核，保留相应状态。确需计算、制图或进一步来源核查时，留在内部准备记录。'
    ].join('\n'),
    acceptance: resultAcceptance
  });
}
organize('desk-results', '整理第一阶段项目成果', ['extract-project', 'extract-history', 'extract-visit'],
  '边界、用途、历史及现状、企业、踏勘、访谈和图件');

const analysisAcceptance = ['判断与来源、统计口径、调查轮次一致', '结论含范围和局限，有冲突时给核查依据'];
addCandidate({
  id: 'preliminary-analysis', title: '形成第一阶段分析与后续建议', stageId: 'draft', agentId: 'analysis',
  dependsOn: ['desk-results'],
  instructions: '仅使用经确认的第一阶段成果。按对象、活动、潜在污染物、迁移途径和受体组织可追溯判断。给出是否仍需采样验证的依据、适用范围及不确定性，专业路线由用户决定。JSON 包含 conclusions、openQuestions 和依据使用的成果 ID。',
  acceptance: analysisAcceptance
});
addHuman('investigation-route', '专业确认第一阶段结论及调查路线',
  '核对第一阶段分析、未解决的疑点及调查依据，再确认交付第一阶段内部稿或进入采样调查。',
  ['preliminary-analysis'], 'human_decision', undefined,
  [{ id: 'preliminary', label: '第一阶段结题' }, { id: 'sampling', label: '进入后续采样调查' }]);
addCandidate({
  id: 'sampling-plan', title: '编制候选采样方案', stageId: 'organize', agentId: 'analysis', when: sampling,
  dependsOn: ['desk-results', 'preliminary-analysis', 'investigation-route'],
  instructions: '由已确认成果和路线形成候选采样方案。交代目标、重点区、各点位目的、介质、层位、检测项、对照和质控。保留方案边界及专业核查事项；区分拟实施和已实施。',
  acceptance: ['每个点位及项目有来源与理由', '方案条件和待决策项明确', '经专业审核后可进入委托待办']
});
addHuman('commission', '确认委托与已批准的方案',
  '记录真实委托、采用的采样方案版本和委托范围。', ['sampling-plan'], 'human_action', sampling);
addHuman('lab-work-complete', '确认采样和检测机构已完成工作',
  '按真实外部进展确认涉及的范围、批次和报告。确认后再请求现场、检测及质控资料。',
  ['commission'], 'external_milestone', sampling);
extract('extract-field', '提取现场采样和样品流转记录', ['field-records'],
  '点位、介质、层位、时间、样品 ID、实际工作量、流转和原始记录', sampling, ['lab-work-complete']);
extract('extract-lab', '提取检测结果和分析方法', ['detection-report'],
  '方法、检出限、逐样数据、单位、ND、监测项目和检测报告适用范围', sampling, ['lab-work-complete']);
extract('extract-qc', '提取质控和验证记录', ['qc-evidence'],
  '批次、空白、平行样配对、质量指标和原报告判定', sampling, ['lab-work-complete']);
organize('sampling-results', '整理采样、检测与质控成果',
  ['sampling-plan', 'extract-field', 'extract-lab', 'extract-qc'],
  '方案与实际差异、样品身份、逐样原值、对照、质控与可用展示素材', sampling);
addCandidate({
  id: 'sampling-analysis', title: '分析检测结果、评价与不确定性', stageId: 'draft', agentId: 'analysis',
  when: sampling, dependsOn: ['desk-results', 'preliminary-analysis', 'sampling-results'],
  instructions: '根据已确认成果完成结果、评价与适用局限。区分常规/平行/对照样、介质、空间和深度，沿用已经确认的统计比较和判定口径。需要新计算或专业核查时在内部记录依据及影响，供人工复核。JSON 包含 conclusions、limitations、applicabilityDecisions、resultIds；明确需要用户决定的条件性职责。',
  acceptance: analysisAcceptance
});

function headingsFor(chapter, section, first) {
  return [
    ...(first ? [{ level: 1, title: chapter.id + ' ' + chapter.title }] : []),
    { level: 2, title: section.id + ' ' + section.title },
    ...section.headings
  ];
}

function outline(route, when, chapters, inputs) {
  const headings = chapters.flatMap(chapter =>
    chapter.sections.flatMap((section, i) => headingsFor(chapter, section, i === 0)));
  const id = 'outline-' + route;
  addCandidate({
    id, title: route === 'complete' ? '整理完整稿目录' : '整理第一阶段目录',
    stageId: 'draft', agentId: 'outline', when, dependsOn: inputs,
    instructions: [
      '输出 JSON 对象，按下面固定目录保留稳定编号和标题。仅在 3.3、3.4 按确有成果引用的企业新增三级和四级节点，保留对象 ID、来源及理由。无依据的对象留在单独内部说明。条件性职责保留适用性标记。',
      ...headings.map(heading => heading.title)
    ].join('\n'),
    acceptance: ['固定目录缺项或重命名应退回', '动态标题逐一对应实际企业和确认成果']
  });
  return id;
}

function fullInputs(section) {
  const chapter = Number(section.id.split('.')[0]);
  if (chapter <= 3) {
    if (['1.1', '1.5'].includes(section.id)) return ['desk-results', 'preliminary-analysis', 'sampling-results'];
    return ['desk-results', 'preliminary-analysis'];
  }
  if (chapter <= 5) return ['sampling-results', 'sampling-analysis'];
  if (chapter === 6) return ['desk-results', 'sampling-results', 'sampling-analysis'];
  return ['desk-results', 'preliminary-analysis', 'sampling-analysis'];
}

function buildReport(route, when, round, chapters) {
  const complete = route === 'complete';
  const outlineId = outline(route, when, chapters,
    complete ? ['desk-results', 'sampling-results'] : ['desk-results']);
  const documents = [];
  const reportHeadings = [];
  for (const chapter of chapters) {
    for (const [i, section] of chapter.sections.entries()) {
      const headings = headingsFor(chapter, section, i === 0);
      const paragraphPlan = section.paragraphs.filter(p => p.fromRound <= round);
      const assetSlots = section.displaySlots.filter(p => p.fromRound <= round);
      const id = route + '-' + section.id.replace('.', '-');
      const inputs = complete ? fullInputs(section) : ['desk-results', 'preliminary-analysis'];
      addCandidate({
        id, title: section.id + ' ' + section.title + (complete ? '（完整稿）' : '（第一阶段）'),
        stageId: 'draft', agentId: 'writing', when, format: 'markdown',
        dependsOn: [...inputs, outlineId, 'investigation-route'],
        markdown: { headings },
        instructions: [
          '只返回本小节 Markdown。根据收集资料显示，逐段就地交代对象、范围、依据和结论，使用已审核成果及适用目录。数字、比较和新结论留在上游确认。',
          '正文仅写证据支持的叙述；待核、缺料、内部 Todo、审核疑问放入 limitations。条件性职责依经审决定展开。图位按已绑定来源和图题记录素材引用；禁止临时生成图片。表格只能使用已审核的表位/原值引用。',
          ...(section.byEnterprise ? ['按已审目录中的实际企业分组，展开每家企业的层级标题和对应业务段落。'] : []),
          ...paragraphPlan.map(p => p.id + (p.conditional ? '（条件项）' : '') + ' ' + p.topic + '。' + p.argument),
          ...assetSlots.map(s => s.id + (s.kind === 'table' ? ' 表位 ' : ' 图位 ') + s.title)
        ].join('\n'),
        acceptance: [
          '章节层级与固定标题完整，企业动态标题与已审核目录一致',
          '逐段核对已确认成果、编号、单位、对象、适用时点和完成情况',
          '图表引用可回到已审核图表来源，内部核查事项留在审核记录'
        ]
      });
      documents.push(id);
      reportHeadings.push(...headings);
    }
  }
  addCandidate({
    id: 'report-' + route, title: complete ? '组装完整内部审阅稿' : '组装第一阶段内部审阅稿',
    stageId: 'deliver', agentId: 'delivery', when, format: 'markdown', script: true,
    dependsOn: documents, markdown: { headings: reportHeadings, assembly: 'concatenate' },
    word: { fileName: 'report-' + route + '.docx',
      title: complete ? '地块土壤污染状况调查报告（完整内审稿）' : '地块土壤污染状况调查报告（第一阶段内审稿）',
      tocDepth: 4, bodyFont: '宋体', headingFont: '黑体', firstLineIndent: 480 },
    instructions: '按模板既定顺序直接组装已审核小节，保留完整标题和正文。对照成果及图表的原件用于审核。',
    acceptance: ['目录及章节固定标题完整', '保留每个已审核小节原文和顺序', '人工批准后下载内部审阅稿']
  });
}

buildReport('preliminary', preliminary, 2, profile.chapters.slice(0, 3));
buildReport('complete', sampling, 3, profile.chapters);

const pkg = {
  protocol: 'hh.package/1', id: 'land-investigation-report', version: '0.5.0',
  title: '环评 · 地块土壤污染状况调查',
  description: '从环评工作台 P2p 拆出的独立项目模板。含第一阶段及进入采样两条路线，由已验收的分节结果生成 Markdown 和 Word 内审稿。',
  stages, agents, capabilities, assets: [], materials, workOrders, steps, outputs
};
// One object per line keeps the distributed JSON both inspectable and within
// the standard upload limit. The editable business definitions live above and in the profile.
const fields = Object.entries(pkg).map(([key, value]) =>
  '  ' + JSON.stringify(key) + ': ' + (Array.isArray(value) && value.length
    ? '[\n    ' + value.map(item => JSON.stringify(item)).join(',\n    ') + '\n  ]'
    : JSON.stringify(value)));
const serialized = '{\n' + fields.join(',\n') + '\n}\n';
if (Buffer.byteLength(serialized) > 200000) throw new Error('Human Harness upload limit is 200 KB');
for (const step of steps) {
  if (step.instructions.length > 4000) throw new Error('Step exceeds protocol instruction limit: ' + step.id);
}
if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8') !== serialized) throw new Error('Generated project template is out of date');
} else {
  writeFileSync(outputPath, serialized);
}
