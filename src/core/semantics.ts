import type { ProjectState, RuntimeArtifact } from './runtime';
import type { SemanticNote } from '../protocol/semantics';

/** Retrieve only current, accepted source revisions and the latest approved
 * Agent result for each producing task. Older/unreviewed notes remain in history,
 * never in the active project knowledge used by the next Agent.
 */
export function approvedSemanticNotes(project: ProjectState, scopedMaterialIds: readonly string[]): SemanticNote[] {
  const allowed = new Map<string, RuntimeArtifact>();
  for (const materialId of scopedMaterialIds) {
    const material = project.materials[materialId];
    if (material?.state !== 'accepted') continue;
    const artifact = project.artifacts.find(a => a.id === material.artifactIds.at(-1) &&
      a.kind === 'material' && a.ownerId === materialId);
    if (artifact) allowed.set(materialId, artifact);
  }

  const result: SemanticNote[] = [];
  for (const step of project.package.steps) {
    if (project.steps[step.id]?.state !== 'done') continue;
    const output = project.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === step.id).at(-1);
    if (!output) continue;
    for (const note of output.semanticNotes ?? []) {
      const accepted = allowed.get(note.materialId);
      if (accepted && accepted.id === note.sourceArtifactId &&
          accepted.revision === note.sourceRevision) {
        result.push(note);
        if (result.length >= 30) return result;
      }
    }
  }
  return result;
}
