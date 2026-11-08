import { NextResponse } from 'next/server';
import { createProject, listProjects, listPackages, RuntimeError } from '@/core/store';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ projects: listProjects(), packages: listPackages(), executor: process.env.HH_EXECUTOR === 'mastra' ? 'mastra' : 'demo' });
}
export async function POST(request: Request) {
  try {
    const data: unknown = await request.json();
    if (!data || typeof data !== 'object') throw new RuntimeError('Request must be an object');
    const { packageId, title } = data as Record<string, unknown>;
    if (typeof packageId !== 'string' || typeof title !== 'string') throw new RuntimeError('packageId and title are required');
    return NextResponse.json({ project: createProject(packageId, title) }, { status: 201 });
  } catch (error) {
    if (!(error instanceof RuntimeError)) console.error('Project creation error:', error);
    return NextResponse.json({ error: error instanceof RuntimeError ? error.message : 'Project creation failed' }, { status: error instanceof RuntimeError ? 400 : 500 });
  }
}
