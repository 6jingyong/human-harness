import { expect, test } from '@playwright/test';

test('native Codex lookup goes from the visual template to a reviewed project handoff', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: /新建模板/ }).click();
  const editor = page.getByRole('region', { name: '项目模板编辑器' });
  const fields = editor.getByRole('region', { name: '流程任务属性' });
  await editor.getByText('模板资料与阶段').click();
  await editor.getByLabel('模板 ID').fill('native-mcp-handoff');
  await editor.locator('[data-flow-card="step:draft"]').click();
  await fields.getByText('Codex MCP', { exact: true }).click();
  await fields.getByLabel('调用一个只读 MCP 工具').check();
  await fields.getByRole('button', { name: '查看本机可用工具' }).click();
  await fields.getByLabel('本机可用的只读工具').selectOption('hh_smoke/sample_lookup');
  await fields.getByLabel('MCP 固定参数（JSON 对象）').fill('{"sampleId":"DEMO-01"}');
  await editor.getByRole('button', { name: /添加任务/ }).click();
  await fields.getByLabel('任务名称').fill('交接已核对的目录结果');
  await fields.getByLabel('前置任务', { exact: true }).selectOption({ label: '生成待审成果' });
  await editor.getByRole('button', { name: '验证并保存模板' }).click();
  await expect(page.getByRole('status')).toContainText('native-mcp-handoff @ 1.0.0');

  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByLabel('本次项目名称').fill('Synthetic MCP handoff');
  await page.getByRole('button', { name: /创建项目/ }).click();
  const created = page.waitForResponse(response => response.url().endsWith('/api/v1/projects') &&
    response.request().method() === 'POST' && response.status() === 201);
  await page.getByRole('button', { name: '确认并启动项目' }).click();
  const { project } = await (await created).json();
  const human = page.getByRole('region', { name: '人类 TodoList' });
  await human.getByRole('button', { name: /原始资料/ }).click();
  await page.getByLabel('资料内容 / 来源说明').fill('SYNTHETIC_INPUT_ONLY');
  await page.getByRole('button', { name: '提交资料，等待人工核验' }).click();
  await page.getByRole('button', { name: '确认接受材料' }).click();

  const projectUrl = '/api/v1/projects/' + project.id;
  await expect.poll(async () => {
    const { project } = await (await page.request.get(projectUrl)).json();
    const run = project.runs.at(-1);
    if (run?.status === 'failed') throw new Error(run.error);
    return project.steps.draft.state;
  }, { timeout: 45000 }).toBe('review');
  const { project: reviewed } = await (await page.request.get(projectUrl)).json();
  expect(reviewed.runs).toHaveLength(1);
  expect(reviewed.runs[0].codexMcpLookup).toBe('hh_smoke/sample_lookup');
  expect(reviewed.runs[0].codexThreadId).toBeTruthy();
  expect(reviewed.runs[0].codexTurnId).toBeUndefined();
  const result = reviewed.artifacts.find((item: { ownerId: string }) => item.ownerId === 'draft');
  expect(result.content).toContain('Synthetic lookup succeeded.');
  expect(result.content).toContain('DEMO-01');
  expect(result.content).not.toContain('SYNTHETIC_INPUT_ONLY');
  const handoff = human.getByRole('button', { name: /交接已核对的目录结果/ });
  await expect(handoff).toHaveCount(0);
  await human.getByRole('button', { name: /生成待审成果/ }).click();
  await page.getByRole('button', { name: '批准并交接下游' }).click();
  await expect(handoff).toBeVisible();
});
