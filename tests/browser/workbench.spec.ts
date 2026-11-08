import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';

test('Human Harness supports document → Agent → Human → Agent GUI handoff', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /从项目模板开始/ })).toBeVisible();
  // Wait until client hydration and the async template index have both finished.
  await expect(page.locator('#package-select')).toContainText('双文档信息核对与交付');
  await page.getByLabel('本次项目名称').fill('GUI 闭环测试 ' + Date.now());
  await page.getByRole('button', { name: /创建项目/ }).click();
  await expect(page.getByRole('heading', { name: '人机任务工作台' })).toBeVisible();

  const queue = page.getByRole('navigation', { name: '任务队列' });
  async function submitDocument(title: string, inputId: string, name: string, mimeType: string) {
    await queue.getByRole('button', { name: new RegExp(title) }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await page.locator('#material-file-' + inputId).setInputFiles({
      name, mimeType, buffer: Buffer.from(name.startsWith('a') ? '%PDF-1.7\nFixture only' : 'PK\x03\x04Fixture only')
    });
    await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
    await expect(page.getByRole('button', { name: '确认接受材料' })).toBeVisible();
    await page.getByRole('button', { name: '确认接受材料' }).click();
    await expect(page.getByText('资料已接受，后续 Agent 只能读取经授权的版本。')).toBeVisible();
  }

  await submitDocument('第一份资料（PDF）', 'source-a', 'a.pdf', 'application/pdf');
  await submitDocument('第二份资料（DOCX）', 'source-b', 'b.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  // CI exercises a clearly marked demo response, never real document parsing.
  await queue.getByRole('button', { name: /抽取两份文档中的关键事实/ }).click();
  await expect(page.getByRole('button', { name: '批准并交接下游' })).toBeVisible();
  await expect(page.locator('.workbench-inspector .result')).toContainText('演示结果');
  await page.getByRole('button', { name: '批准并交接下游' }).click();

  await queue.getByRole('button', { name: /确认缺失信息或冲突的处理意见/ }).click();
  await page.getByLabel('完成情况、结论或交接给 Agent 的信息')
    .fill('已核对两份原件，记录冲突的修正依据（浏览器测试数据）。');
  await page.getByRole('button', { name: '确认完成并交接' }).click();

  await queue.getByRole('button', { name: /根据资料与人工核对生成成果/ }).click();
  await expect(page.getByRole('button', { name: '批准并交接下游' })).toBeVisible();
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await expect(page.getByRole('link', { name: '下载已审核成果' })).toBeVisible();
  await page.screenshot({ path: 'test-results/human-harness-workbench.png', fullPage: true });
});

test('project scheduler controls stay interactive with Human Todo', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#package-select')).toContainText('双文档信息核对与交付');
  await page.getByLabel('本次项目名称').fill('调度操作测试 ' + Date.now());
  await page.getByRole('button', { name: /创建项目/ }).click();
  await expect(page.getByText('自动派发已开启')).toBeVisible();

  await page.getByRole('button', { name: '暂停自动派发' }).click();
  await expect(page.getByText('自动派发已暂停')).toBeVisible();
  await page.getByLabel('项目 Agent 最大并发数').selectOption('1');
  await expect(page.getByLabel('项目 Agent 最大并发数')).toHaveValue('1');

  const queue = page.getByRole('navigation', { name: '任务队列' });
  await queue.getByRole('button', { name: /第一份资料（PDF）/ }).click();
  await expect(page.locator('#material-file-source-a')).toBeEnabled();
  await page.getByRole('button', { name: '恢复自动派发' }).click();
  await expect(page.getByText('自动派发已开启')).toBeVisible();
});
