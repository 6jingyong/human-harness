import { NextResponse } from 'next/server';
import { getProject } from '@/core/store';
import { ensureLocalScheduler } from '@/executors/scheduler';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    ensureLocalScheduler();
    const project = getProject(id);
    // Never disclose filesystem paths from stored private artifacts through the web API.
    const safe = { ...project, artifacts: project.artifacts.map(({ filePath: _hidden, ...artifact }) => artifact) };
    return NextResponse.json({ project: safe });
  } catch { return NextResponse.json({ error: 'Project not found' }, { status: 404 }); }
}
