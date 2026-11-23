import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { projectLaunchSchema } from '@/protocol/project-launch';
import { createProject, getModelSettings, listProjects, RuntimeError } from '@/core/store';
import { getLaunchablePackage, listLaunchablePackages } from '@/app/launch-templates';
import { ensureLocalScheduler } from '@/executors/scheduler';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';

export async function GET() {
  ensureLocalScheduler();
  const settings = getModelSettings();
  return NextResponse.json({ settings, projects: listProjects(), packages: listLaunchablePackages(), executor: settings.provider });
}
export async function POST(request: Request) {
  try {
    const { packageId, packageVersion, title, setup } = projectLaunchSchema.parse(await request.json());
    const project = createProject(getLaunchablePackage(packageId, packageVersion), title, setup);
    ensureLocalScheduler();
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: '请检查项目名称、日期和资源设置。' }, { status: 400 });
    }
    if (!(error instanceof RuntimeError)) console.error('Project creation error:', error);
    return NextResponse.json({ error: error instanceof RuntimeError ? error.message : 'Project creation failed' }, { status: error instanceof RuntimeError ? 400 : 500 });
  }
}
