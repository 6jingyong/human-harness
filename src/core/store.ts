import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import builtin from '../../examples/land-investigation.hh.json';
import { packageSchema, taskPacketSchema, taskResultSchema, type HumanHarnessPackage, type HumanHarnessTaskResult } from '../protocol/v1';
import {
  applyHumanStep, createTaskPacket, expireAbandonedRun, failAgent, finishAgent, freshId, newProject, now, receiveMaterial,
  reconcile, recordEvent, reserveAgent, retryAgent, reviewAgent, reviewMaterial,
  type ProjectState, type RuntimeArtifact
} from './runtime';

export class RuntimeError extends Error {}
const dir = process.env.HH_DATA_DIR ? resolve(process.env.HH_DATA_DIR) : join(process.cwd(), '.human-harness');
mkdirSync(dir, { recursive: true });
const db = new Database(join(dir, 'protocol-v1.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec([
  'CREATE TABLE IF NOT EXISTS packages (id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, definition TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, version))',
  'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, package_id TEXT NOT NULL, package_version TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS event_log (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), type TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_runtime_projects ON projects(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_runtime_events ON event_log(project_id, created_at)'
].join(';') + ';');

const builtinPackage = packageSchema.parse(builtin);
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const asError = (e: unknown) => e instanceof Error ? e : new Error(String(e));

export function listPackages() {
  const custom = db.prepare('SELECT id, version, definition FROM packages ORDER BY created_at DESC').all() as Array<{ id: string; version: string; definition: string }>;
  const selected = new Map<string, HumanHarnessPackage>();
  selected.set(builtinPackage.id, builtinPackage);
  for (const row of custom) {
    const pkg = packageSchema.parse(JSON.parse(row.definition));
    if (!selected.has(pkg.id)) selected.set(pkg.id, pkg);
  }
  return [...selected.values()].map(pkg => ({
    id: pkg.id, version: pkg.version, title: pkg.title, description: pkg.description,
    stages: pkg.stages.length, materials: pkg.materials.length, steps: pkg.steps.length,
    builtin: pkg.id === builtinPackage.id
  }));
}

export function getPackage(id: string, version?: string): HumanHarnessPackage {
  if (id === builtinPackage.id && (!version || version === builtinPackage.version)) return builtinPackage;
  const row = version
    ? db.prepare('SELECT definition FROM packages WHERE id = ? AND version = ?').get(id, version) as { definition: string } | undefined
    : db.prepare('SELECT definition FROM packages WHERE id = ? ORDER BY created_at DESC LIMIT 1').get(id) as { definition: string } | undefined;
  if (!row) throw new RuntimeError('Project package not found');
  return packageSchema.parse(JSON.parse(row.definition));
}

export function importPackage(raw: unknown) {
  const pkg = packageSchema.parse(raw);
  if (pkg.id === builtinPackage.id) throw new RuntimeError('Built-in package ID cannot be overwritten');
  const check = inspectReadiness(pkg);
  if (check.errors.length) throw new RuntimeError('Package has unavailable capabilities: ' + check.errors.join('; '));
  try {
    db.prepare('INSERT INTO packages (id, version, digest, definition, created_at) VALUES (?, ?, ?, ?, ?)').run(
      pkg.id, pkg.version, digest(pkg), JSON.stringify(pkg), now()
    );
  } catch (e) {
    if (/UNIQUE constraint/.test(asError(e).message)) throw new RuntimeError('This package ID/version already exists; create a new version');
    throw e;
  }
  return { id: pkg.id, version: pkg.version, title: pkg.title };
}

export function inspectReadiness(pkg: HumanHarnessPackage): { errors: string[] } {
  const allowed = new Set(['mastra.agent']);
  const errors: string[] = [];
  for (const cap of pkg.capabilities) {
    if (!allowed.has(cap.id)) errors.push(cap.id + ': capability not installed');
  }
  if (pkg.assets.length) errors.push('Asset bundles are not installed by the current JSON-only runtime');
  if (pkg.steps.some(s => s.kind === 'script')) errors.push('Script steps are not wired to Protocol 1.0 yet');
  if (pkg.outputs.some(o => !['markdown', 'json'].includes(o.format))) errors.push('DOCX/PDF renderer not installed');
  return { errors };
}

export function listProjects() {
  return db.prepare('SELECT id, title, package_id, package_version, created_at FROM projects ORDER BY created_at DESC').all() as Array<{ id: string; title: string; package_id: string; package_version: string; created_at: string }>;
}

function loadProject(id: string): ProjectState {
  const row = db.prepare('SELECT state FROM projects WHERE id = ?').get(id) as { state: string } | undefined;
  if (!row) throw new RuntimeError('Project not found');
  return JSON.parse(row.state) as ProjectState;
}

export const getProject = (id: string): ProjectState => loadProject(id);

function persist(project: ProjectState, newEvents: number): void {
  const start = project.events.length - newEvents;
  const eventInsert = db.prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?, ?)');
  for (const e of project.events.slice(start)) {
    eventInsert.run(e.id, project.id, e.type, e.subject, e.detail, e.createdAt);
  }
  db.prepare('UPDATE projects SET state = ? WHERE id = ?').run(JSON.stringify(project), project.id);
}

function mutate<T>(id: string, fn: (p: ProjectState) => T): { project: ProjectState; value: T } {
  return db.transaction(() => {
    const project = loadProject(id);
    const count = project.events.length;
    const value = fn(project);
    persist(project, project.events.length - count);
    return { project, value };
  })();
}

export function createProject(packageId: string, rawTitle: string): ProjectState {
  const title = rawTitle.trim();
  if (!title || title.length > 150) throw new RuntimeError('Project title must be between 1 and 150 characters');
  const pkg = getPackage(packageId);
  const readiness = inspectReadiness(pkg);
  if (readiness.errors.length) throw new RuntimeError(readiness.errors.join('; '));
  const project = newProject(pkg, freshId(), title, digest(pkg));
  db.transaction(() => {
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run(
      project.id, title, pkg.id, pkg.version, JSON.stringify(project), project.createdAt
    );
    for (const e of project.events) {
      db.prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?, ?)').run(
        e.id, project.id, e.type, e.subject, e.detail, e.createdAt
      );
    }
  })();
  return project;
}

export function completeHuman(id: string, stepId: string, value: string) {
  if (value.length > 8000) throw new RuntimeError('Human input is too long');
  return mutate(id, p => applyHumanStep(p, stepId, value)).project;
}

export type UploadInput = { name: string; buffer: Buffer } | undefined;
const textExtensions = new Set(['.txt', '.md', '.json', '.csv', '.geojson', '.kml', '.yaml', '.yml']);
export function submitMaterial(id: string, materialId: string, rawText: string, upload?: UploadInput): ProjectState {
  const content = rawText.trim();
  if (content.length > 30000) throw new RuntimeError('Text exceeds 30,000 characters');
  if (!content && !upload) throw new RuntimeError('Please enter text or upload a file');
  if (upload && (upload.buffer.byteLength === 0 || upload.buffer.byteLength > 12 * 1024 * 1024)) {
    throw new RuntimeError('File must be between 1 byte and 12 MB');
  }
  // Don't store original names as paths. Uploaded bytes never enter publicly served directories.
  const artifactId = freshId();
  const filePath = upload ? join(dir, 'uploads', artifactId) : undefined;
  if (filePath && upload) {
    mkdirSync(join(dir, 'uploads'), { recursive: true });
    writeFileSync(filePath, upload.buffer, { flag: 'wx' });
  }
  try {
    return mutate(id, p => {
      const def = p.package.materials.find(m => m.id === materialId);
      if (!def) throw new RuntimeError('Material requirement is not declared in this package');
      if (!upload && !def.formats.includes('text/plain')) {
        throw new RuntimeError('This requirement needs an original file; text notes alone are insufficient');
      }
      if (upload && !def.formats.some(x => x !== 'text/plain')) {
        throw new RuntimeError('This requirement expects text rather than an uploaded file');
      }
      const name = upload ? basename(upload.name).slice(0, 150) || 'upload' : '用户文本说明';
      const readable = upload && textExtensions.has(extname(name).toLowerCase())
        ? upload.buffer.toString('utf8').slice(0, 30000) : null;
      const artifact: RuntimeArtifact = {
        id: artifactId, kind: 'material', name,
        content: content || readable, ownerId: materialId,
        revision: p.materials[materialId].artifactIds.length + 1, createdAt: now(),
        ...(filePath ? { filePath } : {})
      };
      receiveMaterial(p, materialId, artifact);
    }).project;
  } catch (e) {
    if (filePath && existsSync(filePath)) unlinkSync(filePath);
    throw e;
  }
}

export const reviewReceivedMaterial = (id: string, materialId: string, accepted: boolean, feedback: string) =>
  mutate(id, p => reviewMaterial(p, materialId, accepted, feedback.slice(0, 1000))).project;

export function startAgent(id: string, requestedStepId?: string): { project: ProjectState; stepId: string; runId: string } {
  const { project, value } = mutate(id, p => {
    const step = requestedStepId
      ? p.package.steps.find(s => s.id === requestedStepId)
      : p.package.steps.find(s => (s.kind === 'agent' || s.kind === 'script') && p.steps[s.id].state === 'ready');
    if (!step) throw new RuntimeError('No ready Agent task');
    const runId = reserveAgent(p, step.id);
    return { stepId: step.id, runId };
  });
  return { project, ...value };
}
export function getTaskPacket(id: string, stepId: string, runId: string) {
  return taskPacketSchema.parse(createTaskPacket(loadProject(id), stepId, runId));
}

/** Store only Codex runtime identities/brief event types, never model-controlled project mutations. */
export function recordExecutorEvent(id: string, stepId: string, runId: string,
  event: { kind: 'thread' | 'turn'; id: string } | { kind: 'progress'; message: string }) {
  return mutate(id, p => {
    const run = p.runs.find(r => r.id === runId && r.stepId === stepId);
    if (!run || run.status !== 'running' || p.steps[stepId]?.runId !== runId ||
        p.steps[stepId]?.state !== 'running') {
      throw new RuntimeError('Stale or unknown Codex run event');
    }
    if (event.kind === 'thread') {
      if (run.codexThreadId && run.codexThreadId !== event.id) throw new RuntimeError('Codex thread identity changed');
      run.codexThreadId = event.id;
      recordEvent(p, 'executor.thread', stepId, event.id);
    } else if (event.kind === 'turn') {
      if (!run.codexThreadId) throw new RuntimeError('Codex turn arrived before thread');
      if (run.codexTurnId && run.codexTurnId !== event.id) throw new RuntimeError('Codex turn identity changed');
      run.codexTurnId = event.id;
      recordEvent(p, 'executor.turn', stepId, event.id);
    } else {
      run.lastExecutorEvent = event.message.slice(0, 150);
      // Progress is a status snapshot. Avoid a large SQLite event ledger for every token.
    }
  }).project;
}

export function succeedAgent(id: string, stepId: string, runId: string, rawResult: unknown, output: string) {
  const result = taskResultSchema.parse(rawResult);
  if (!output.trim() || output.length > 120000) throw new RuntimeError('Agent returned empty or oversized output');
  return mutate(id, p => {
    const step = p.package.steps.find(s => s.id === stepId);
    if (!step) throw new RuntimeError('Unknown producing step');
    const contract = p.package.outputs.find(o => o.id === step.outputContractId);
    if (contract?.format === 'json') {
      try { JSON.parse(output); } catch { throw new RuntimeError('Output contract requires valid JSON'); }
    }
    const artifactRef = result.producedArtifacts[0]?.artifactRef;
    if (!artifactRef) throw new RuntimeError('Agent result missing produced artifact reference');
    const artifact: RuntimeArtifact = {
      id: artifactRef, kind: 'agent_output',
      name: contract?.fileName ?? stepId + '.md', content: output,
      ownerId: stepId,
      revision: p.artifacts.filter(a => a.ownerId === stepId && a.kind === 'agent_output').length + 1,
      createdAt: now()
    };
    finishAgent(p, stepId, runId, result, artifact);
  }).project;
}

export const reviewAgentOutput = (id: string, stepId: string, accepted: boolean, feedback: string) =>
  mutate(id, p => reviewAgent(p, stepId, accepted, feedback)).project;
export const markAgentFailed = (id: string, stepId: string, runId: string, error: string) =>
  mutate(id, p => failAgent(p, stepId, runId, error)).project;
export const retryFailedAgent = (id: string, stepId: string) =>
  mutate(id, p => retryAgent(p, stepId)).project;
export const recoverAbandonedAgent = (id: string, stepId: string) =>
  mutate(id, p => expireAbandonedRun(p, stepId)).project;

export function latestOutput(project: ProjectState, stepId: string) {
  return project.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === stepId).at(-1);
}
