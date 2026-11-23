import { getProject } from '@/core/store';
import { currentApprovedOutput } from '@/core/runtime';
import { renderApprovedWord } from '@/core/word-export';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';

/** Download only an explicitly reviewed output contract from the current project. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string; artifactId: string }> }) {
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
    const requested = new URL(request.url).searchParams.get('format');
    if (requested !== null && requested !== 'docx') {
      return Response.json({ error: 'Unsupported download format' }, { status: 400 });
    }
    if (requested === 'docx' && !contract.word) {
      return Response.json({ error: 'Word export is not enabled by this template' }, { status: 404 });
    }
    const word = requested === 'docx' ? contract.word : undefined;
    let body: BodyInit = artifact.content;
    if (word) {
      try { body = renderApprovedWord(artifact.content, project.title, word); }
      catch (error) {
        console.error('Approved Word export failed for artifact', artifactId, error instanceof Error ? error.name : '');
        return Response.json({ error: 'Word export could not be generated' }, { status: 500 });
      }
    }
    const contentType = word ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : contract.format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8';
    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'attachment; filename="' + (word?.fileName ?? contract.fileName) + '"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch { return Response.json({ error: 'Project not found' }, { status: 404 }); }
}
