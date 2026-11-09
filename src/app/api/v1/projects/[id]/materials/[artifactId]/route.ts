import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { getProject } from '@/core/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Local-only access to project-owned originals; never disclose internal paths. */
export async function GET(_request: Request, context: { params: Promise<{ id: string; artifactId: string }> }) {
  const { id, artifactId } = await context.params;
  try {
    const project = getProject(id);
    const artifact = project.artifacts.find(a =>
      a.id === artifactId && a.kind === 'material' && Boolean(a.filePath));
    if (!artifact?.filePath) return NextResponse.json({ error: 'Original not found' }, { status: 404 });
    const bytes = readFileSync(artifact.filePath);
    // The artifact reference is a random ID within the pinned project. Only the
    // content is returned; internal paths are never part of the response.
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': "attachment; filename=\"original\"; filename*=UTF-8''" +
          encodeURIComponent(artifact.name),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch {
    return NextResponse.json({ error: 'Original not found' }, { status: 404 });
  }
}
