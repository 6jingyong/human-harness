import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';

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

  await human.getByRole('button', { name: /根据资料与人工核对生成成果/ }).click();
  await expect(page.getByRole('button', { name: '批准并交接下游' })).toBeVisible();
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await expect(human.getByRole('button')).toHaveCount(0);

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
  await page.route('**/api/v1/projects/*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    if (!data.project?.steps?.extract) return route.fulfill({ response });
    data.project.steps.extract.state = 'waiting_input';
    data.project.humanRequests = [{
      id: 'preview-request-1', stepId: 'extract', runId: 'preview-run',
      materialId: 'source-a', reason: '请确认原始资料的最新版本和来源。',
      status: 'pending', createdAt: '2026-11-09T00:00:00Z'
    }];
    await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const human = page.getByRole('region', { name: '人类 TodoList' });
  const agent = page.getByRole('region', { name: 'Agent TodoList' });
  await expect(human.getByRole('button', { name: /补充说明：第一份资料/ })).toBeVisible();
  await expect(agent.getByText('等待人工答复')).toBeVisible();
  await human.getByRole('button', { name: /补充说明：第一份资料/ }).click();
  await expect(page.getByRole('button', { name: '提交回复并继续 Agent' })).toBeVisible();
  await page.screenshot({ path: 'test-results/human-harness-request-preview.png', fullPage: true });
});
