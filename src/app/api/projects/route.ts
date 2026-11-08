import { NextResponse } from 'next/server';
import { createProject, DomainError, listProjects, listTemplateSummaries } from '@/lib/store';
import { executorMode } from '@/lib/executor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    projects: listProjects(),
    templates: listTemplateSummaries(),
    executorMode
  });
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object') throw new DomainError('Invalid request');
    const input = body as Record<string, unknown>;
    if (typeof input.templateId !== 'string' || typeof input.title !== 'string') throw new DomainError('Missing templateId or title');
    const project = createProject(input.templateId, input.title);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    if (!(error instanceof DomainError)) console.error('Project creation error:', error);
    return NextResponse.json({ error: error instanceof DomainError ? error.message : 'Failed to create project' },
      { status: error instanceof DomainError ? 400 : 500 });
  }
}
