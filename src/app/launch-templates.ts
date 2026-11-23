import bundledLandInvestigation from '../../project-templates/land-investigation/land-investigation.hh.json';
import { getPackage, listPackages, RuntimeError } from '@/core/store';
import { packageSchema } from '@/protocol/v1';

export const landInvestigationReference = packageSchema.parse(bundledLandInvestigation);

export function listLaunchablePackages() {
  const packages = listPackages();
  const reference = landInvestigationReference;
  if (packages.some(pkg => pkg.id === reference.id)) return packages;
  return [...packages, {
    id: reference.id, version: reference.version, title: reference.title, description: reference.description,
    stages: reference.stages.length, materials: reference.materials.length, steps: reference.steps.length, builtin: true
  }];
}

export function getLaunchablePackage(id: string, version?: string) {
  try {
    return getPackage(id, version);
  } catch (error) {
    if (error instanceof RuntimeError && id === landInvestigationReference.id &&
        (!version || version === landInvestigationReference.version)) return landInvestigationReference;
    throw error;
  }
}
