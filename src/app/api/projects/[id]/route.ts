import { NextResponse } from 'next/server';
import { getProject } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  return NextResponse.json({ project });
}
