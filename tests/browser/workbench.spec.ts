import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

async function installFixture(page: import('@playwright/test').Page, id: string) {
  const installed = await page.request.get('/api/v1/packages?id=' + id);
  if (installed.ok()) return;
  const file = new URL('../../examples/' + id + '.hh.json', import.meta.url);
  const response = await page.request.post('/api/v1/packages', {
    data: JSON.parse(readFileSync(file, 'utf8'))
  });
  expect(response.status()).toBe(201);
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => console.error('BROWSER PAGE ERROR:', error.message));
  page.on('console', message => {
    if (message.type() === 'error') console.error('BROWSER CONSOLE:', message.text());
  });
});

async function createProject(page: import('@playwright/test').Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(page.locator('#package-select')).toContainText('双文档信息核对与交付');
  await page.getByLabel('本次项目名称').fill(title + ' ' + Date.now());
  await page.getByRole('button', { name: /创建项目/ }).click();
  await page.getByRole('button', { name: '确认并启动项目' }).click();
  await expect(page.getByRole('heading', { name: /Human Todo/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Agent Todo/ })).toBeVisible();
  // Wait for the off-canvas menu's closing transition before snapshots.
  await expect(page.getByRole('button', { name: '打开菜单' })).toBeVisible();
  await expect(page.locator('.navigation-drawer')).not.toBeVisible();
}

test('simple two-row UI completes Human → Agent → Human → Agent and opens material library', async ({ page }) => {
  await createProject(page, '双 Todo 浏览器闭环');
  const human = page.getByRole('region', { name: '人类 TodoList' });
  const agent = page.getByRole('region', { name: 'Agent TodoList' });
  await expect(page.locator('.todo-detail-wrap')).toHaveCount(0);
  await expect(human.getByRole('button')).toHaveCount(2);
  await expect(agent.locator('.agent-folder')).toHaveCount(2);
  await expect(agent.locator('.workbench-item')).toHaveCount(2);
  await expect(agent.locator('.agent-folder').first()).toContainText('Agent A · 资料提取');
  await expect(agent.locator('.agent-folder').nth(1)).toContainText('Agent B · 成果整理');
  const blocked = agent.locator('.agent-folder').first().locator('.agent-state-folder');
  await expect(blocked.locator('summary')).toContainText('等待依赖');
  await blocked.locator('summary').click();
  await expect(blocked.getByRole('button', { name: /抽取两份文档中的关键事实/ })).toBeVisible();
  await blocked.locator('summary').click();

  // Capture the actual minimal home as requested by the product owner.
  await page.screenshot({ path: 'test-results/human-harness-home.png', fullPage: true });

  async function submitDocument(title: string, id: string, name: string, mimeType: string) {
    await human.getByRole('button', { name: new RegExp(title) }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await page.locator('#material-file-' + id).setInputFiles({
      name, mimeType, buffer: Buffer.from(name.endsWith('.pdf') ? '%PDF-1.7\nFixture only' : 'PK\x03\x04Fixture only')
    });
    await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
    await page.getByRole('button', { name: '确认接受材料' }).click();
    await expect(human.getByRole('button', { name: new RegExp(title) })).toHaveCount(0);
  }
  await submitDocument('第一份资料（PDF）', 'source-a', 'sample.pdf', 'application/pdf');
  await submitDocument('第二份资料（DOCX）', 'source-b', 'sample.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  // Clearly-marked demo: tests Human Harness routing, not document content extraction.
  await human.getByRole('button', { name: /抽取两份文档中的关键事实/ }).click();
  await expect(page.locator('.todo-detail-wrap .result')).toContainText('演示结果');
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await human.getByRole('button', { name: /确认缺失信息或冲突的处理意见/ }).click();
  await page.getByLabel('完成情况、结论或交接给 Agent 的信息')
    .fill('人工核对已完成，并说明冲突修正依据。');
  await page.getByRole('button', { name: '确认完成并交接' }).click();

  const delivery = page.getByRole('region', { name: '项目交付' });
  await delivery.getByRole('button', { name: '打开验收待办' }).click();
  await expect(page.getByRole('button', { name: '批准并交接下游' })).toBeVisible();
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await expect(human.getByRole('button')).toHaveCount(0);
  await expect(delivery.getByRole('link', { name: '下载交付件' })).toBeVisible();

  await page.getByRole('button', { name: '查看项目资料' }).click();
  await expect(page.getByRole('heading', { name: '项目资料' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '原始资料' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agent 语义说明' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '保存原件' })).toHaveCount(2);
  await page.locator('.semantic-result').first().locator('summary').click();
  await expect(page.getByRole('link', { name: '下载已审核成果' }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/human-harness-materials.png', fullPage: true });
  await page.getByRole('button', { name: '← 返回 Todo' }).click();
  await expect(page.getByRole('heading', { name: /Human Todo/ })).toBeVisible();
});

test('hamburger drawer holds project scheduler settings while Todo remains accessible', async ({ page }) => {
  await createProject(page, '菜单与并发');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(page.getByText('正在自动执行')).toBeVisible();
  await page.getByRole('button', { name: '暂停自动派发' }).click();
  await expect(page.getByText('已暂停新任务')).toBeVisible();
  await page.getByLabel('项目 Agent 最大并发数').selectOption('1');
  await expect(page.getByLabel('项目 Agent 最大并发数')).toHaveValue('1');
  await page.getByRole('button', { name: '恢复自动派发' }).click();
  await expect(page.getByText('正在自动执行')).toBeVisible();
  await page.getByRole('button', { name: '关闭菜单' }).click();
  await page.getByRole('region', { name: '人类 TodoList' }).getByRole('button', { name: /第一份资料/ }).click();
  await expect(page.locator('#material-file-source-a')).toBeEnabled();
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await expect(page.locator('.todo-detail-wrap')).toHaveCount(0);
});


test('Agent-generated Human Todo is visible beside the paused Agent (visual fixture)', async ({ page }) => {
  await createProject(page, '待补充问题界面预览（模拟状态）');
  let showAttachmentReview = false;
  await page.route('**/api/v1/projects/*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    if (!data.project?.steps?.extract) return route.fulfill({ response });
    data.project.steps.extract.state = 'waiting_input';
    if (showAttachmentReview) {
      data.project.materials['source-a'].state = 'received';
      data.project.materials['source-a'].artifactIds = ['preview-file'];
      data.project.artifacts.push({
        id: 'preview-file', kind: 'material', name: '新版本原件.pdf',
        ownerId: 'source-a', revision: 1, content: null, createdAt: '2026-11-09T00:00:00Z'
      });
    }
    data.project.humanRequests = [{
      id: 'preview-request-1', stepId: 'extract', runId: 'preview-run',
      materialId: 'source-a', reason: '请确认原始资料的最新版本和来源。',
      status: showAttachmentReview ? 'awaiting_review' : 'pending',
      ...(showAttachmentReview ? { attachmentArtifactId: 'preview-file' } : {}),
      createdAt: '2026-11-09T00:00:00Z'
    }];
    await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const human = page.getByRole('region', { name: '人类 TodoList' });
  const agent = page.getByRole('region', { name: 'Agent TodoList' });
  await expect(human.getByRole('button', { name: /补充说明：第一份资料/ })).toBeVisible();
  await expect(agent.getByText('等待人工答复')).toBeVisible();
  await human.getByRole('button', { name: /补充说明：第一份资料/ }).click();
  await expect(page.getByRole('button', { name: '提交说明并继续 Agent' })).toBeVisible();
  await expect(page.locator('#human-request-file-preview-request-1')).toBeVisible();
  await page.screenshot({ path: 'test-results/human-harness-request-preview.png', fullPage: true });
  showAttachmentReview = true;
  await expect(page.getByRole('button', { name: '验收原件并继续 Agent' })).toBeVisible();
  await page.locator('#human-request-review-preview-request-1')
    .fill('本次模拟审核意见：原件版本仍需核验。');
  await expect(page.getByRole('button', { name: '退回补充文件' })).toBeEnabled();
  await page.screenshot({ path: 'test-results/human-harness-attachment-review-preview.png', fullPage: true });
});


test('source replacement stays in the library until Human approves the revision and reopens only affected work', async ({ page }) => {
  await createProject(page, '原件版本变更浏览器测试');
  const human = page.getByRole('region', { name: '人类 TodoList' });
  async function add(title: string, id: string, filename: string, mimeType: string) {
    await human.getByRole('button', { name: new RegExp(title) }).click();
    await page.locator('#material-file-' + id).setInputFiles({
      name: filename, mimeType, buffer: Buffer.from('Fixture original for ' + filename)
    });
    await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
    await page.getByRole('button', { name: '确认接受材料' }).click();
  }
  await add('第一份资料（PDF）', 'source-a', 'source-a.pdf', 'application/pdf');
  await add('第二份资料（DOCX）', 'source-b', 'source-b.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await human.getByRole('button', { name: /抽取两份文档中的关键事实/ }).click();
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await human.getByRole('button', { name: /确认缺失信息或冲突的处理意见/ }).click();
  await page.getByLabel('完成情况、结论或交接给 Agent 的信息').fill('人工已审核提取结果。');
  await page.getByRole('button', { name: '确认完成并交接' }).click();
  await human.getByRole('button', { name: /根据资料与人工核对生成成果/ }).click();
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await expect(human.getByRole('button')).toHaveCount(0);

  // Pause only future dispatch, making the invalidation state inspectable.
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '暂停自动派发' }).click();
  await page.getByRole('button', { name: '关闭菜单' }).click();

  await page.getByRole('button', { name: '查看项目资料' }).click();
  const first = page.locator('.library-material').first();
  await first.locator('.source-replacement summary').click();
  await first.locator('#replacement-file-source-a').setInputFiles({
    name: 'source-a-v2.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('Revised source PDF with corrected fields')
  });
  await first.getByRole('button', { name: '提交新版本，等待审核' }).click();
  await expect(first.getByText('新资料等待验收。')).toBeVisible();
  await page.getByRole('button', { name: '← 返回 Todo' }).click();
  await human.getByRole('button', { name: /第一份资料（PDF）/ }).click();
  await expect(page.getByRole('button', { name: '确认接受材料' })).toBeVisible();
  await page.getByRole('button', { name: '确认接受材料' }).click();

  // Extract and its dependent reports are stale; unrelated sources remain accepted.
  await expect(page.getByRole('region', { name: 'Agent TodoList' })
    .getByRole('button', { name: /抽取两份文档中的关键事实/ })).toBeVisible();
  await expect(human.getByRole('button', { name: /根据资料与人工核对生成成果/ })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/human-harness-source-replacement.png', fullPage: true });

  await page.getByRole('button', { name: '查看项目资料' }).click();
  const latest = page.locator('.library-material').first();
  await expect(latest).toContainText('source-a-v2.pdf');
  await expect(latest).toContainText('当前接受版本');
  await expect(page.locator('.semantic-result').first()).not.toContainText('已审核');
});


test('template-defined method checks reach the Human reviewer without implying a Demo pass', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(page.locator('#package-select')).toContainText('双来源技术规格核对');
  await page.locator('#package-select').selectOption('technical-spec-review');
  await page.getByLabel('本次项目名称').fill('方法模板界面验收 ' + Date.now());
  await page.getByRole('button', { name: /创建项目/ }).click();
  await page.getByRole('button', { name: '确认并启动项目' }).click();
  const human = page.getByRole('region', { name: '人类 TodoList' });
  const agents = page.getByRole('region', { name: 'Agent TodoList' });
  await expect(agents.locator('.agent-folder')).toHaveCount(3);
  async function submitText(title: RegExp, materialId: string, content: string) {
    await human.getByRole('button', { name: title }).click();
    await page.locator('#material-text-' + materialId).fill(content);
    await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
    await page.getByRole('button', { name: '确认接受材料' }).click();
  }
  await submitText(/需求方技术要求/, 'purchase-spec',
    '正式需求：额定电压220 V，功率7.5 kW；2026-10-05发布。');
  await submitText(/供应商技术规格/, 'supplier-spec',
    '供方原件：额定电压380 V，功率7.5 kW；未说明版次。');

  await human.getByRole('button', { name: /提取需求方参数/ }).click();
  await expect(page.getByText('模板检查项（Agent 自检，须人工复核）')).toBeVisible();
  await expect(page.getByText('Demo 未运行模型、专业 Skill 或实际验证方法', {
    exact: false
  }).first()).toBeVisible();
  const approve = page.getByRole('button', { name: '批准并交接下游' });
  await expect(approve).toBeDisabled();
  await page.locator('#agent-review-check-demand').fill(
    '本次仅验收 UI 提交状态；Demo 未验证源文件，结论仍应在真实任务中重新核对。');
  await expect(approve).toBeEnabled();
  await page.screenshot({ path: 'test-results/human-harness-method-checks.png', fullPage: true });

  await page.getByRole('button', { name: '查看项目资料' }).click();
  const source = page.locator('.library-material').first();
  await source.getByText('查看模板的资料获取、信息提取与核验方法').click();
  await expect(source).toContainText('获取：');
  await expect(source).toContainText('提取：');
  await page.screenshot({ path: 'test-results/human-harness-template-methods.png', fullPage: true });
});


test('EIA pilot template appears in dual Todos and never grants Demo professional approval', async ({ page }) => {
  await installFixture(page, 'eia-source-replay');
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(page.locator('#package-select')).toContainText('环评素材来源与半成品复核');
  await page.locator('#package-select').selectOption('eia-source-replay');
  await page.getByLabel('本次项目名称').fill('环评真实素材回放流程（模拟录入）' + Date.now());
  await page.getByRole('button', { name: /创建项目/ }).click();
  await page.getByRole('button', { name: '确认并启动项目' }).click();

  const human = page.getByRole('region', { name: '人类 TodoList' });
  const agent = page.getByRole('region', { name: 'Agent TodoList' });
  await expect(agent.locator('.agent-folder')).toHaveCount(3);
  await expect(agent.locator('.agent-folder').nth(0)).toContainText('企业资料');
  await expect(agent.locator('.agent-folder').nth(1)).toContainText('质控图件');
  await expect(agent.locator('.agent-folder').nth(2)).toContainText('交付边界');
  await expect(human.getByRole('button')).toHaveCount(5);
  await expect(human.getByRole('button', { name: /补证/ })).toHaveCount(0);

  // CI uploads real text/JSON *file bytes*, not pasted strings; contents are synthetic,
  // never private EIA source files. Exercise the same upload workflow used by the operator.
  const plain = [
    ['enterprise-original', /企业来源原文/, 'original.txt', 'text/plain',
      'SOURCE: synthetic enterprise statement'],
    ['enterprise-extracted', /企业字段候选分析/, 'candidate.json', 'application/json',
      '{"schema":"synthetic-review","last_field":"REACHED_JSON_END"}'],
    ['frozen-analysis', /封存分析成果快照/, 'frozen.json', 'application/json',
      '{"source_manifest":[],"kind":"internal-synthetic"}']
  ] as const;
  for (const [id, title, filename, mimeType, contents] of plain) {
    await human.getByRole('button', { name: title }).click();
    await page.locator('#material-file-' + id).setInputFiles({
      name: filename, mimeType, buffer: Buffer.from(contents)
    });
    await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
    await page.getByRole('button', { name: '确认接受材料' }).click();
  }
  const binary = [
    ['qc-scan', /质控报告扫描PDF/, 'synthetic.pdf', 'application/pdf'],
    ['word-candidate', /处理后Word单节半成品/, 'synthetic.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  ] as const;
  for (const [id, title, filename, mimeType] of binary) {
    await human.getByRole('button', { name: title }).click();
    await page.locator('#material-file-' + id).setInputFiles({
      name: filename, mimeType, buffer: Buffer.from('TEST FIXTURE ONLY - no real parsing')
    });
    await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
    await page.getByRole('button', { name: '确认接受材料' }).click();
  }

  await human.getByRole('button', { name: /企业源文与候选字段一致性复核/ }).click();
  await expect(page.getByText('模板检查项（Agent 自检，须人工复核）')).toBeVisible();
  await expect(page.getByText('Demo 未运行模型、专业 Skill 或实际验证方法', {
    exact: false
  }).first()).toBeVisible();
  const approve = page.getByRole('button', { name: '批准并交接下游' });
  await expect(approve).toBeDisabled();
  await page.screenshot({ path: 'test-results/human-harness-eia-pilot.png', fullPage: true });

  await page.getByRole('button', { name: '查看项目资料' }).click();
  const library = page.locator('.library-material').filter({ hasText: '质控报告扫描PDF' }).first();
  await library.getByText('查看模板的资料获取、信息提取与核验方法').click();
  await expect(library).toContainText('视觉');
  await page.screenshot({ path: 'test-results/human-harness-eia-material-methods.png', fullPage: true });
});


test('EIA A→B→C template keeps stage roles separate and produces a downloaded C candidate after Human review (Demo only)', async ({ page }) => {
  await installFixture(page, 'eia-abc-pipeline');
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(page.locator('#package-select')).toContainText('环评 A→B→C 分阶段并行流水线');
  await page.locator('#package-select').selectOption('eia-abc-pipeline');
  await page.getByLabel('本次项目名称').fill('ABC分阶段业务验收 ' + Date.now());
  await page.getByRole('button', { name: /创建项目/ }).click();
  await page.getByRole('button', { name: '确认并启动项目' }).click();
  const human = page.getByRole('region', { name: '人类 TodoList' });
  const agent = page.getByRole('region', { name: 'Agent TodoList' });
  await expect(human.getByRole('button')).toHaveCount(5);
  await expect(agent.locator('.agent-folder')).toHaveCount(3);
  await expect(agent.locator('.agent-folder').nth(0)).toContainText('Agent A · 结果提取');
  await expect(agent.locator('.agent-folder').nth(1)).toContainText('Agent B · 分析结论');
  await expect(agent.locator('.agent-folder').nth(2)).toContainText('Agent C · 最终成果');
  await expect(agent.locator('.workbench-item')).toHaveCount(5);
  await page.screenshot({ path: 'test-results/human-harness-abc-home.png', fullPage: true });

  async function addText(input: RegExp, id: string, content: string) {
    await human.getByRole('button', { name: input }).click();
    await page.locator('#material-text-' + id).fill(content);
    await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
    await page.getByRole('button', { name: '确认接受材料' }).click();
  }
  async function addFile(input: RegExp, id: string, filename: string, mimeType: string, content: string) {
    await human.getByRole('button', { name: input }).click();
    await page.locator('#material-file-' + id).setInputFiles({
      name: filename, mimeType, buffer: Buffer.from(content)
    });
    await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
    await page.getByRole('button', { name: '确认接受材料' }).click();
  }
  async function approve(title: RegExp, stepId: string) {
    await human.getByRole('button', { name: title }).click();
    await page.locator('#agent-review-' + stepId).fill(
      '仅验证系统分阶段交接与审批，不代表对合成示例或扫描文件作专业事实认证。');
    await page.getByRole('button', { name: '批准并交接下游' }).click();
  }

  await addText(/企业陈述原文/, 'enterprise-original', '企业陈述：历史活动需核实。');
  await addFile(/企业字段提取半成品/, 'enterprise-half-result', 'enterprise.json',
    'application/json', '{"results":[{"label":"historical activity","status":"unverified"}]}');
  await expect(human.getByRole('button', { name: /A1 · 企业资料转换成事实结果/ })).toBeVisible();
  await human.getByRole('button', { name: /A1 · 企业资料转换成事实结果/ }).click();
  await expect(page.locator('.todo-detail-wrap .result')).toContainText('"demo": true');
  await expect(page.getByRole('button', { name: '批准并交接下游' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/human-harness-abc-a-result.png', fullPage: true });
  await page.locator('#agent-review-a-enterprise-results').fill('只作流水线验证，结果未经真实提取。');
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await expect(human.getByRole('button', { name: /B1 · 企业结果形成风险分析结论/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/human-harness-abc-b-conclusion.png', fullPage: true });

  await addFile(/检测质控扫描PDF/, 'qc-scan', 'qc.pdf', 'application/pdf', '%PDF synthetic fixture');
  await addFile(/质控封存分析半成品/, 'qc-frozen-result', 'frozen.json',
    'application/json', '{"results":[{"status":"unverified"}]}');
  await addFile(/已有Word半成品/, 'word-reference', 'sample.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'PK synthetic fixture');
  await approve(/A2 · 质控资料转换成检测结果/, 'a-qc-results');
  await approve(/B1 · 企业结果形成风险分析结论/, 'b-enterprise-analysis');
  await approve(/B2 · 检测结果形成质控分析结论/, 'b-qc-analysis');
  await human.getByRole('button', { name: /确认两路分析结论的采用与修改意见/ }).click();
  await page.getByLabel('完成情况、结论或交接给 Agent 的信息')
    .fill('仅检验成果交付；任何专业结论均未实际核实，不得用于对外项目。');
  await page.getByRole('button', { name: '确认完成并交接' }).click();
  await expect(human.getByRole('button', { name: /C · 已审核结论生成最终内部成果/ })).toBeVisible();
  await human.getByRole('button', { name: /C · 已审核结论生成最终内部成果/ }).click();
  await expect(page.getByRole('button', { name: '批准并交接下游' })).toBeDisabled();
  await page.locator('#agent-review-c-final-output').fill(
    '已确认此文件只是Demo格式测试，真实环境成果仍需专业校核。');
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await page.getByRole('button', { name: '查看项目资料' }).click();
  const finalResult = page.locator('.project-deliverable').filter({ hasText: '最终内部报告' }).first();
  await finalResult.locator('summary').first().click();
  const downloadLink = finalResult.getByRole('link', { name: '下载已审核成果' });
  await expect(downloadLink).toBeVisible();
  const url = await downloadLink.getAttribute('href');
  expect(url).toBeTruthy();
  const fetched = await page.request.get(url!);
  expect(fetched.ok()).toBeTruthy();
  expect(fetched.headers()['content-disposition']).toContain('eia-internal-final.md');
  expect(await fetched.text()).toContain('演示结果');
  await page.screenshot({ path: 'test-results/human-harness-abc-c-output.png', fullPage: true });
});


test('approved output can be Human-revised from the library; dependent review reopens without overwriting history', async ({ page }) => {
  await createProject(page, '人工修订已批准成果浏览器闭环');
  const human = page.getByRole('region', { name: '人类 TodoList' });
  for (const item of [
    { title: '第一份资料（PDF）', id: 'source-a', name: 'review-a.pdf', mimeType: 'application/pdf' },
    { title: '第二份资料（DOCX）', id: 'source-b', name: 'review-b.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  ]) {
    await human.getByRole('button', { name: new RegExp(item.title.replace(/[()]/g, '\\$&')) }).click();
    await page.locator('#material-file-' + item.id).setInputFiles({
      name: item.name, mimeType: item.mimeType, buffer: Buffer.from(item.name)
    });
    await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
    await page.getByRole('button', { name: '确认接受材料' }).click();
  }
  await human.getByRole('button', { name: /抽取两份文档中的关键事实/ }).click();
  await expect(page.getByRole('button', { name: '批准并交接下游' })).toBeVisible();
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await human.getByRole('button', { name: /确认缺失信息或冲突的处理意见/ }).click();
  await page.getByLabel('完成情况、结论或交接给 Agent 的信息').fill('人工已确认这份数据仅用于演示。');
  await page.getByRole('button', { name: '确认完成并交接' }).click();
  await human.getByRole('button', { name: /根据资料与人工核对生成成果/ }).click();
  await page.getByRole('button', { name: '批准并交接下游' }).click();

  await page.getByRole('button', { name: '查看项目资料' }).click();
  const extraction = page.locator('.project-deliverable').filter({ hasText: '内部待核对信息表' }).first();
  const final = page.locator('.project-deliverable').filter({ hasText: '最终待审信息整理稿' }).first();
  await extraction.locator('summary').first().click();
  await expect(extraction).toContainText('当前有效版本 HEAD：v1');
  await extraction.getByText('人类修订当前已批准成果（保留所有历史）').click();
  await extraction.getByRole('button', { name: '复制当前 HEAD 到编辑区' }).click();
  const editor = extraction.getByLabel('新的完整成果内容');
  await expect(editor).not.toHaveValue('');
  await editor.fill((await editor.inputValue()) + '\\n人工审定补充条目。');
  await extraction.getByLabel('修改或恢复原因（必填）').fill('人工复核后补充说明，保留旧版记录');
  await expect(extraction).toContainText('预计影响后继任务 2 项');
  await extraction.getByRole('button', { name: '记录修订、更新 HEAD 并重开受影响任务' }).click();
  await expect(page.getByRole('status')).toContainText('人工成果修订已记录');
  await expect(extraction).toContainText('当前有效版本 HEAD：v2');
  await expect(final).toContainText('旧版已失效');
  await expect(final.getByRole('link', { name: '下载已审核成果' })).toHaveCount(0);
  await extraction.getByText('查看完整历史版本（2）').click();
  await expect(extraction).toContainText('人工复核后补充说明');
  await expect(extraction).toContainText('人工审定补充条目');

  await page.getByRole('button', { name: '← 返回 Todo' }).click();
  await expect(human.getByRole('button', { name: /确认缺失信息或冲突的处理意见/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agent TodoList' })).toContainText('等待依赖');
});

test('the bundled land template is selectable and a local JSON import can still be edited and launched', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  const packageSelect = page.locator('#package-select');
  await expect(packageSelect).toContainText('双文档信息核对与交付');
  await expect(packageSelect).toContainText('环评 · 地块土壤污染状况调查 · 0.5.0');
  await page.getByLabel('导入本地 JSON 模板').setInputFiles(fileURLToPath(
    new URL('../../project-templates/land-investigation/land-investigation.hh.json', import.meta.url)
  ));
  const flow = page.getByRole('region', { name: '项目双轴流程图' });
  await expect(flow.getByRole('heading', { name: '必须由人完成' })).toBeVisible();
  await expect(flow.getByRole('heading', { name: '可交给 AI／程序' })).toBeVisible();
  await page.getByLabel('查找任务').fill('调查路线');
  const route = flow.getByRole('button', { name: /专业确认第一阶段结论及调查路线/ });
  await expect(route).toHaveAttribute('data-lane', 'human');
  await route.click();
  await expect(page.getByLabel('选项 1')).toHaveValue('第一阶段结题');
  await expect(page.getByLabel('选项 2')).toHaveValue('进入后续采样调查');
  await page.getByLabel('查找任务').fill('组装第一阶段');
  await expect(flow.locator('[data-flow-card="step:report-preliminary"]')).toHaveAttribute('data-lane', 'machine');
  await expect(flow.locator('[data-flow-card="review:report-preliminary"]')).toHaveAttribute('data-lane', 'human');
  await page.getByRole('button', { name: '验证并保存模板' }).click();
  await expect(page.getByRole('status')).toContainText('land-investigation-report @ 0.5.0');

  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(packageSelect).toHaveValue('land-investigation-report');
  await page.getByLabel('本次项目名称').fill('独立环评模板浏览器测试');
  await page.getByRole('button', { name: /创建项目/ }).click();
  await page.getByRole('button', { name: '确认并启动项目' }).click();
  const human = page.getByRole('region', { name: '人类 TodoList' });
  const agent = page.getByRole('region', { name: 'Agent TodoList' });
  await expect(human.getByRole('button', { name: /现场踏勘/ })).toBeVisible();
  await expect(human.getByRole('button', { name: /正式检测报告/ })).toHaveCount(0);
  await expect(agent).toContainText('素材提取');
});

test('project plan can be saved, prioritizes a Human Todo, and opens the same task', async ({ page }) => {
  await createProject(page, '填排程资源与优先顺序');
  await page.getByRole('button', { name: '项目计划', exact: true }).click();
  const plan = page.getByRole('region', { name: '项目计划', exact: true });
  const gantt = plan.getByRole('region', { name: '项目甘特图' });
  await expect(gantt).toBeVisible();
  await plan.getByText('工作日与资源容量').click();
  await plan.getByLabel('每人每天可投入小时').fill('3');
  await gantt.getByRole('button', { name: /第二份资料/ }).click();
  const details = plan.getByRole('region', { name: '排程任务详情' });
  await details.getByLabel('估计工时（小时）').fill('1.5');
  await details.getByRole('button', { name: '设为优先' }).click();
  await plan.getByRole('button', { name: '锁定基准' }).click();
  await expect(plan.getByRole('status')).toContainText('已锁定计划基准');
  await details.getByRole('button', { name: '去处理 Todo' }).click();
  const human = page.getByRole('region', { name: '人类 TodoList' });
  await expect(human.getByRole('button').first()).toContainText('第二份资料');
  await expect(human.getByRole('button').first()).toContainText('优先');
  await expect(page.locator('#material-file-source-b')).toBeVisible();
});

test('delivery requirements turn into owner Todos, and solicitation does not count as receipt', async ({ page }) => {
  const packageId = 'land-investigation-report';
  if (!(await page.request.get('/api/v1/packages?id=' + packageId)).ok()) {
    const file = new URL('../../project-templates/land-investigation/land-investigation.hh.json', import.meta.url);
    const imported = await page.request.post('/api/v1/packages', { data: JSON.parse(readFileSync(file, 'utf8')) });
    expect(imported.status()).toBe(201);
  }
  const title = '一人公司项目要求闭环 ' + Date.now();
  const created = await page.request.post('/api/v1/projects', { data: { packageId, title } });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  const action = async (form: Record<string, string>) => {
    const response = await page.request.post('/api/v1/projects/' + project.id + '/actions', { multipart: form });
    expect(response.status()).toBe(200);
  };
  await action({ action: 'submit_material', materialId: 'project-identity', value: '测试工程身份' });
  await action({ action: 'accept_material', materialId: 'project-identity' });

  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  const requirements = page.getByRole('region', { name: '项目要求' });
  const human = page.getByRole('region', { name: '人类 TodoList' });
  await expect(human.getByRole('button', { name: /提前联系地测/ })).toHaveCount(0);
  await requirements.getByRole('button', { name: '设置项目要求' }).click();
  await requirements.getByRole('checkbox', { name: '本项目需要外包地测' }).check();
  await requirements.getByLabel('外包地测验收截止日').fill('2034-11-27');
  await requirements.getByRole('checkbox', { name: '本项目需要政府调档' }).check();
  await requirements.getByLabel('政府调档验收截止日').fill('2034-11-27');
  await requirements.getByRole('button', { name: '保存并更新 Todo' }).click();
  await expect(human.getByRole('button', { name: /提前联系地测/ })).toContainText('最晚开始');
  await expect(human.getByRole('button', { name: /确认调档机关/ })).toBeVisible();
  await expect(human.getByRole('button', { name: /地测机构成果及交付文件/ })).toHaveCount(0);

  const note = page.getByLabel('完成情况、结论或交接给 Agent 的信息');
  await human.getByRole('button', { name: /提前联系地测/ }).click();
  await note.fill('测试联络，已核对档期');
  await page.getByRole('button', { name: '确认完成并交接' }).click();
  await human.getByRole('button', { name: /核对地测档期并确认委托/ }).click();
  await note.fill('测试委托回执编号 100');
  await page.getByLabel('对方承诺回件日').fill('2034-11-23');
  await page.getByRole('button', { name: '确认完成并交接' }).click();

  await human.getByText(/等待外部回件/).click();
  await human.getByRole('button', { name: /核实地测机构回件/ }).click();
  await expect(page.getByText('对方承诺回件 2034-11-23')).toBeVisible();
  await note.fill('已主动跟进，仍在等待回件');
  await page.getByRole('button', { name: '记录跟进，继续等待' }).click();
  await expect(page.getByText('上次记录 已主动跟进，仍在等待回件')).toBeVisible();
  await expect(human.getByRole('button', { name: /地测机构成果及交付文件/ })).toHaveCount(0);
  await note.fill('实际回件已收到，编号 110');
  await page.getByRole('button', { name: '确认实际回件' }).click();
  await expect(human.getByRole('button', { name: /地测机构成果及交付文件/ })).toBeVisible();
});

test('startup previews template deliverables and carries requirements into the first Human Todo', async ({ page }) => {
  const packageId = 'land-investigation-report';
  if (!(await page.request.get('/api/v1/packages?id=' + packageId)).ok()) {
    const file = new URL('../../project-templates/land-investigation/land-investigation.hh.json', import.meta.url);
    const imported = await page.request.post('/api/v1/packages', { data: JSON.parse(readFileSync(file, 'utf8')) });
    expect(imported.status()).toBe(201);
  }
  const title = '由模板和实际要求启动 ' + Date.now();
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.locator('#package-select').selectOption(packageId);
  await page.getByLabel('本次项目名称').fill(title);
  await page.getByRole('button', { name: /创建项目/ }).click();
  const launch = page.getByRole('form', { name: '项目启动设置' });
  const preview = launch.getByRole('region', { name: '启动预览' });
  await launch.getByLabel('项目交付日').fill('2034-12-01');
  await launch.getByLabel('每人每天可投入小时').fill('3');
  await launch.getByRole('checkbox', { name: '本项目需要外包地测' }).check();
  await launch.getByLabel('外包地测验收截止日').fill('2034-11-27');
  await expect(preview.getByText('提供素材 · 项目身份与调查目的')).toBeVisible();
  await expect(preview.getByText('组装完整内部审阅稿')).toContainText('DOCX');
  await expect(preview.getByText('提前联系地测机构')).toBeVisible();
  await expect(preview.getByText('地测机构成果及交付文件')).toHaveCount(0);

  const before = await (await page.request.get('/api/v1/projects')).json();
  expect(before.projects.some((project: { title: string }) => project.title === title)).toBe(false);
  await launch.getByRole('button', { name: '确认并启动项目' }).click();
  const todo = page.getByRole('region', { name: '人类 TodoList' });
  await expect(todo.getByRole('button', { name: /提前联系地测机构/ })).toBeVisible();
  await expect(todo.getByRole('button', { name: /地测机构成果及交付文件/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '项目要求' })).toContainText('2034-11-27');
});

test('the visual template editor connects a Human prerequisite and starts a project without editing JSON', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: /新建模板/ }).click();
  const editor = page.getByRole('region', { name: '项目模板编辑器' });
  const graph = editor.getByRole('region', { name: '项目双轴流程图' });
  const fields = editor.getByRole('region', { name: '流程任务属性' });
  await editor.getByText('模板资料与阶段').click();
  await editor.getByLabel('模板 ID').fill('workbench-visual-template');
  await editor.getByLabel('模板名称', { exact: true }).fill('可视化模板闭环验证');
  await editor.getByRole('button', { name: /添加任务/ }).click();
  await fields.getByLabel('任务名称').fill('确认素材使用权');
  await expect(graph.getByRole('button', { name: /确认素材使用权/ })).toHaveAttribute('data-lane', 'human');
  await graph.locator('[data-flow-card="step:draft"]').click();
  await fields.getByLabel('前置任务', { exact: true }).selectOption({ label: '确认素材使用权' });
  await expect(fields.getByRole('button', { name: '解除 确认素材使用权' })).toBeVisible();
  await expect(graph.locator('svg > path.dependency').first()).toBeAttached();
  await page.screenshot({ path: 'test-results/template-flow-editor.png', fullPage: true });
  await graph.locator('[data-flow-card="review:draft"]').click();
  const deliveryFlag = fields.getByLabel('列入项目交付');
  await expect(deliveryFlag).toBeChecked();
  await deliveryFlag.uncheck();
  await expect(deliveryFlag).not.toBeChecked();
  await deliveryFlag.check();
  await editor.getByRole('button', { name: '验证并保存模板' }).click();
  await expect(page.getByRole('status')).toContainText('workbench-visual-template @ 1.0.0');

  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByLabel('本次项目名称').fill('素材使用权试跑');
  await page.getByRole('button', { name: /创建项目/ }).click();
  await expect(page.getByText('确认素材使用权')).toBeVisible();
  await page.getByRole('button', { name: '确认并启动项目' }).click();
  const human = page.getByRole('region', { name: '人类 TodoList' });
  await human.getByRole('button', { name: /原始资料/ }).click();
  await page.getByLabel('资料内容 / 来源说明').fill('记录样例');
  await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
  await page.getByRole('button', { name: '确认接受材料' }).click();
  await expect(human.getByRole('button', { name: /生成待审成果/ })).toHaveCount(0);
  await human.getByRole('button', { name: /确认素材使用权/ }).click();
  await page.getByLabel('完成情况、结论或交接给 Agent 的信息').fill('已取得授权，保留凭证');
  await page.getByRole('button', { name: '确认完成并交接' }).click();
  await human.getByRole('button', { name: /生成待审成果/ }).click();
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await expect(page.getByRole('region', { name: '项目交付' }).getByRole('link', { name: '下载交付件' })).toBeVisible();
});

test('the template editor saves Codex Skills on the selected Agent task', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.locator('#package-select').selectOption('general-report');
  await page.getByRole('button', { name: '复制所选模板' }).click();
  const editor = page.getByRole('region', { name: '项目模板编辑器' });
  await editor.locator('[data-flow-card="step:evidence"]').click();
  await editor.getByText('Codex Skills', { exact: true }).click();
  await editor.getByLabel('所需 Skill（每行一个）').fill('documents@local/pdf\ndocx');
  await editor.getByRole('button', { name: '验证并保存模板' }).click();
  await expect(page.getByRole('status')).toContainText('general-report-custom @ 1.0.0');
  const response = await page.request.get('/api/v1/packages?id=general-report-custom');
  expect(response.ok()).toBe(true);
  const { package: saved } = await response.json();
  expect(saved.steps.find((step: { id: string }) => step.id === 'evidence').codexSkills)
    .toEqual(['documents@local/pdf', 'docx']);
});

test('the template editor validates and preserves fixed arguments for direct Codex MCP lookups', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: /新建模板/ }).click();
  const editor = page.getByRole('region', { name: '项目模板编辑器' });
  await editor.getByText('模板资料与阶段').click();
  await editor.getByLabel('模板 ID').fill('workbench-mcp-lookup');
  await editor.locator('[data-flow-card="step:draft"]').click();
  await editor.getByText('Codex MCP', { exact: true }).click();
  await editor.getByLabel('调用一个只读 MCP 工具').check();
  const toolsUrl = '/api/v1/codex/mcp-tools';
  const denied = await page.request.post(toolsUrl, { headers: { origin: 'https://example.invalid' } });
  expect(denied.status()).toBe(403);
  const local = await page.request.post(toolsUrl, { headers: { origin: new URL(page.url()).origin } });
  expect(local.ok()).toBe(true);
  await page.route('**/api/v1/codex/mcp-tools', route => route.fulfill({
    json: { selectors: ['registry/sample_lookup'], unavailable: 1 }
  }));
  await editor.getByRole('button', { name: '查看本机可用工具' }).click();
  await expect(editor.getByRole('status')).toContainText('1 个已授权工具当前不可用');
  await editor.getByLabel('本机可用的只读工具').selectOption('registry/sample_lookup');
  await expect(editor.getByLabel('MCP 服务名称')).toHaveValue('registry');
  await expect(editor.getByLabel('MCP 工具名称')).toHaveValue('sample_lookup');
  const parameters = editor.getByLabel('MCP 固定参数（JSON 对象）');
  await parameters.fill('{"sampleId":');
  await editor.getByRole('button', { name: '验证并保存模板' }).click();
  await expect(editor.getByRole('alert')).toContainText('MCP 固定参数无法解析');
  await parameters.fill('[]');
  await editor.getByRole('button', { name: '编辑完整 JSON' }).click();
  await expect(editor.getByRole('alert')).toContainText('须为 JSON 对象');
  const args = { sampleId: 'DEMO-01', options: { include: ['location'] } };
  await parameters.fill(JSON.stringify(args));
  await editor.locator('[data-flow-card="material:input-01"]').click();
  await editor.locator('[data-flow-card="step:draft"]').click();
  await expect(parameters).toHaveValue(JSON.stringify(args));
  await editor.getByRole('button', { name: '编辑完整 JSON' }).click();
  const jsonEditor = editor.getByLabel('Protocol 1.0 项目模板 JSON');
  const edited = JSON.parse(await jsonEditor.inputValue());
  expect(edited.steps.find((step: { id: string }) => step.id === 'draft').codexMcp.arguments).toEqual(args);
  await editor.getByRole('button', { name: '应用 JSON 到流程图' }).click();
  await editor.getByRole('button', { name: '验证并保存模板' }).click();
  await expect(page.getByRole('status')).toContainText('workbench-mcp-lookup @ 1.0.0');
  const response = await page.request.get('/api/v1/packages?id=workbench-mcp-lookup');
  expect(response.ok()).toBe(true);
  const { package: saved } = await response.json();
  expect(saved.steps.find((step: { id: string }) => step.id === 'draft').codexMcp)
    .toEqual({ server: 'registry', tool: 'sample_lookup', arguments: args });
});

test('the bundled land reference opens directly, exposes gated handoffs, and saves an independent template', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '打开环评参考模板' }).click();
  const editor = page.getByRole('region', { name: '项目模板编辑器' });
  const graph = editor.getByRole('region', { name: '项目双轴流程图' });
  await expect(editor).toContainText('环评 · 地块土壤污染状况调查');
  await editor.getByLabel('查找任务').fill('确认采样和检测机构已完成工作');
  await graph.locator('[data-flow-card="step:lab-work-complete"]').click();
  await editor.getByRole('button', { name: '聚焦关联' }).click();
  await expect(graph.locator('[data-flow-card="step:commission"]')).toBeVisible();
  await expect(graph.locator('[data-flow-card="material:detection-report"]')).toBeVisible();
  await expect(graph.locator('[data-flow-card="step:extract-project"]')).toHaveCount(0);
  await editor.getByRole('button', { name: '验证并保存模板' }).click();
  await expect(page.getByRole('status')).toContainText('land-investigation-report-custom @ 1.0.0');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(page.locator('#package-select')).toHaveValue('land-investigation-report-custom');
  await page.getByRole('button', { name: '打开环评参考模板' }).click();
  await expect(editor).toContainText('v1.0.1');
});

test('project ledger records cash and task time, compares a baseline and rolls up to the company', async ({ page }) => {
  await createProject(page, '项目账务浏览器验收');
  const title = (await page.locator('.simple-project-title h1').textContent())!.trim();
  await page.getByRole('button', { name: '项目账务', exact: true }).click();
  const ledger = page.getByRole('region', { name: '项目账务', exact: true });
  await ledger.getByText('账务设置', { exact: true }).click();
  await ledger.getByLabel('合同约定总额').fill('3000');
  await ledger.getByLabel('人工时薪估值').fill('100');
  await ledger.getByRole('button', { name: '保存账务设置' }).click();
  await expect(ledger.getByRole('region', { name: '合同未收' })).toContainText('3,000.00');
  const record = ledger.getByRole('region', { name: '记一笔' });
  await record.getByLabel('金额（CNY）').fill('1200');
  await record.getByLabel('说明').fill('客户首付款');
  await record.getByRole('button', { name: '保存记录' }).click();
  await expect(ledger.getByRole('region', { name: '合同未收' })).toContainText('1,800.00');
  await ledger.getByRole('button', { name: '返回项目' }).click();

  const human = page.getByRole('region', { name: '人类 TodoList' });
  await human.getByRole('button', { name: /第一份资料/ }).click();
  await page.getByRole('button', { name: '记录本任务投入' }).click();
  await expect(record.getByLabel('关联事项（可选）')).toHaveValue('material:source-a');
  await record.getByLabel('账目类别').selectOption('labor:setup');
  await record.getByLabel('投入分钟').fill('45');
  await record.getByLabel('说明').fill('原件建档');
  await record.getByRole('button', { name: '保存记录' }).click();
  await expect(ledger.getByRole('region', { name: '已记成本' })).toContainText('75.00');
  await expect(ledger.getByRole('region', { name: '账务明细' }).getByText('原件建档')).toBeVisible();

  const compare = ledger.getByRole('region', { name: '对照项目' });
  await compare.getByText('录入历史项目基线').click();
  await compare.getByLabel('历史项目名称').fill('历史同类项目');
  await compare.getByLabel('人工总分钟').fill('85');
  await compare.getByLabel('接入与建档分钟').fill('55');
  await compare.getByRole('button', { name: '保存历史基线' }).click();
  await expect(compare.getByRole('row', { name: /人工总投入/ })).toContainText('−40 分钟');

  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '公司账务' }).click();
  const company = page.getByRole('region', { name: '公司账务', exact: true });
  await expect(company.getByRole('region', { name: 'CNY 汇总' })).toContainText('1,200.00');
  await company.getByRole('button', { name: title, exact: true }).click();
  await expect(ledger.getByRole('region', { name: '客户净回款' })).toContainText('1,200.00');

  await createProject(page, '同模板第二单');
  await page.getByRole('button', { name: '项目账务', exact: true }).click();
  const selector = compare.getByLabel('选择对照');
  const previous = selector.getByRole('option', { name: new RegExp(title) });
  const previousId = await previous.getAttribute('value');
  if (!previousId) throw new Error('找不到已登记账务的对照项目');
  await selector.selectOption(previousId);
  const minutesRow = compare.getByRole('row', { name: /人工总投入/ });
  await expect(minutesRow).toContainText('45 分钟');
  await expect(minutesRow.getByRole('cell').last()).toHaveText('—');
  await record.getByLabel('账目类别').selectOption('labor:setup');
  await record.getByLabel('投入分钟').fill('15');
  await record.getByLabel('说明').fill('复用模板建档');
  await record.getByRole('button', { name: '保存记录' }).click();
  await expect(minutesRow.getByRole('cell').last()).toHaveText('−30 分钟');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('the general report can be copied, launched from the menu and delivered as Word', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  const picker = page.locator('#package-select');
  await picker.selectOption('general-report');
  await page.getByRole('button', { name: '复制所选模板' }).click();
  const editor = page.getByRole('region', { name: '项目模板编辑器' });
  await expect(editor).toContainText('通用报告撰写');
  await expect(editor.locator('[data-flow-card="step:evidence"]')).toBeVisible();
  await expect(editor.locator('[data-flow-card="step:outline"]')).toBeVisible();
  await page.getByRole('button', { name: /返回项目/ }).click();

  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(picker).toHaveValue('general-report');
  await page.getByLabel('本次项目名称').fill('报告模板浏览器试跑');
  await page.getByRole('button', { name: /创建项目/ }).click();
  await expect(page.getByText(/MARKDOWN \/ DOCX/)).toBeVisible();
  await page.getByRole('button', { name: '确认并启动项目' }).click();

  const human = page.getByRole('region', { name: '人类 TodoList' });
  for (const [title, text] of [
    ['报告要求', '供项目负责人判断方案可行性，关注工期及人员。'],
    ['原始资料与来源索引', '项目计划 A 第 2 段记录总工期 15 天。']
  ]) {
    await human.getByRole('button', { name: new RegExp(title) }).click();
    await page.getByLabel('资料内容 / 来源说明').fill(text);
    await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
    await page.getByRole('button', { name: '确认接受材料' }).click();
  }
  for (const title of ['拟定报告提纲', '整理来源证据', '用已审证据撰写报告']) {
    await human.getByRole('button', { name: new RegExp(title) }).click();
    await page.getByRole('button', { name: '批准并交接下游' }).click();
  }
  const delivery = page.getByRole('region', { name: '项目交付' });
  await expect(delivery.getByRole('link', { name: '下载 Markdown' })).toBeVisible();
  await expect(delivery.getByRole('link', { name: '下载 Word' })).toHaveAttribute('href', /format=docx$/);
});
