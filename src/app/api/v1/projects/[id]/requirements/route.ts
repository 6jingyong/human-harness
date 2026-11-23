import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { RuntimeError, saveProjectCoordination } from '@/core/store';
import { ensureLocalScheduler } from '@/executors/scheduler';

export const runtime = 'nodejs';

const requestSchema = z.strictObject({ revision: z.number().int().nonnegative(), settings: z.unknown() });

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { revision, settings } = requestSchema.parse(await request.json());
    const project = saveProjectCoordination(id, revision, settings);
    ensureLocalScheduler();
    return NextResponse.json({ project: { ...project, artifacts: project.artifacts.map(
      ({ filePath: _hidden, ...artifact }) => artifact
    ) } });
  } catch (error) {
    const conflict = error instanceof Error && /重新载入|Dependent Agent work is active/.test(error.message);
    if (conflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof ZodError) return NextResponse.json({ error: '请为已启用的事项填写有效日期和时区。' }, { status: 400 });
    if (error instanceof RuntimeError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof SyntaxError) return NextResponse.json({ error: '项目要求格式无效。' }, { status: 400 });
    console.error('Project requirements update failed', error);
    return NextResponse.json({ error: '无法保存项目要求。' }, { status: 500 });
  }
}
