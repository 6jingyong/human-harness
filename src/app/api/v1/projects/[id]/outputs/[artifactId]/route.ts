import { getProject } from '@/core/store';
import { currentApprovedOutput } from '@/core/runtime';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';

/** Download only an explicitly reviewed output contract from the current project. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string; artifactId: string }> }) {
  try {
    const { id, artifactId } = await ctx.params;
    const project = getProject(id);
    const artifact = project.artifacts.find(a => a.id === artifactId && a.kind === 'agent_output');
    if (!artifact) return Response.json({ error: 'Artifact not found' }, { status: 404 });
    const step = project.package.steps.find(s => s.id === artifact.ownerId);
    const contract = project.package.outputs.find(o => o.id === step?.outputContractId);
    const adopted = currentApprovedOutput(project, artifact.ownerId);
    if (!contract || project.steps[artifact.ownerId]?.state !== 'done' ||
        adopted?.id !== artifact.id || artifact.invalidatedAt) {
      return Response.json({ error: 'Only reviewed deliverables can be exported' }, { status: 409 });
    }
    if (!['markdown', 'json'].includes(contract.format) || typeof artifact.content !== 'string') {
      return Response.json({ error: 'Export renderer is not installed' }, { status: 409 });
    }
    return new Response(artifact.content, {
      headers: {
        'Content-Type': contract.format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + contract.fileName + '"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch { return Response.json({ error: 'Project not found' }, { status: 404 }); }
}
