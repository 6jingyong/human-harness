import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { RuntimeError, saveProjectPlan } from '@/core/store';
import { ensureLocalScheduler } from '@/executors/scheduler';

export const runtime = 'nodejs';

const requestSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  settings: z.unknown(),
  freeze: z.boolean()
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { revision, settings, freeze } = requestSchema.parse(await request.json());
    const { planning } = saveProjectPlan(id, revision, settings, freeze);
    ensureLocalScheduler();
    return NextResponse.json({ planning });
  } catch (error) {
    const conflict = error instanceof RuntimeError && error.message.includes('载入最新设置');
    if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message }, { status: 400 });
    if (error instanceof SyntaxError) return NextResponse.json({ error: '计划数据格式无效' }, { status: 400 });
    if (error instanceof RuntimeError) return NextResponse.json({ error: error.message }, { status: conflict ? 409 : 400 });
    console.error('Project plan update failed', error);
    return NextResponse.json({ error: '无法保存项目计划' }, { status: 500 });
  }
}
