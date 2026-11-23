import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { projectLaunchSchema, templateDeliverables, type LaunchPreview } from '@/protocol/project-launch';
import { previewProject, RuntimeError } from '@/core/store';
import { calculateProjectPlan } from '@/core/project-plan';
import { coordinationOverview } from '@/core/project-coordination';
import { deriveWorkbenchQueues } from '@/app/workbench-queue';
import { getLaunchablePackage } from '@/app/launch-templates';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const { packageId, packageVersion, title, setup } = projectLaunchSchema.parse(await request.json());
    if (!setup) throw new RuntimeError('预览需要项目的时间和资源设置。');
    const project = previewProject(getLaunchablePackage(packageId, packageVersion), title, setup);
    const asOf = new Date();
    const { human, agent } = deriveWorkbenchQueues(project, asOf);
    const plan = calculateProjectPlan(project, setup.planning, asOf);
    const { orderStatus } = coordinationOverview(project, asOf);
    const deliverables = templateDeliverables(project.package);
    const preview: LaunchPreview = {
      humanTodos: human.map(item => ({
        key: item.key, title: item.title, kind: item.kind,
        latestStart: item.timing?.latestStart, lateToStart: item.timing?.lateToStart
      })),
      deliverables: deliverables.map(({ id, title, format, word }) => ({ id, title, format, ...(word ? { word: true } : {}) })),
      readyAgent: agent.filter(item => item.state === 'ready').length,
      finish: plan.finish, behindTarget: plan.behindTarget,
      partial: plan.unresolvedDecisions.length > 0,
      atRisk: (project.package.workOrders ?? []).filter(order => orderStatus.get(order.id)?.atRisk)
        .map(order => order.title)
    };
    return NextResponse.json({ preview });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: '请检查项目名称、日期和资源设置。' }, { status: 400 });
    }
    if (error instanceof RuntimeError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Project preview failed:', error);
    return NextResponse.json({ error: '无法预览项目。' }, { status: 500 });
  }
}
