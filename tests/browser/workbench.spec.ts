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
}

test('simple two-row UI completes Human → Agent → Human → Agent and opens material library', async ({ page }) => {
  await createProject(page, '双 Todo 浏览器闭环');
  const human = page.locator('.todo-row').first();
  const agent = page.locator('.todo-row').nth(1);
  await expect(page.locator('.todo-detail-wrap')).toHaveCount(0);
  await expect(human.getByRole('button')).toHaveCount(2);
  await expect(agent.getByRole('button')).toHaveCount(2);

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
  await page.locator('.todo-row').first().getByRole('button', { name: /第一份资料/ }).click();
  await expect(page.locator('#material-file-source-a')).toBeEnabled();
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await expect(page.locator('.todo-detail-wrap')).toHaveCount(0);
});
