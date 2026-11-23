import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import documentHandoff from '../../examples/document-handoff.hh.json';
import technicalSpecReview from '../../examples/technical-spec-review.hh.json';
import generalReport from '../../examples/general-report.hh.json';
import projectPlan from '../../examples/project-plan.hh.json';
import meetingActions from '../../examples/meeting-actions.hh.json';
import projectRetrospective from '../../examples/project-retrospective.hh.json';
import { MAX_ASSEMBLED_MARKDOWN_LENGTH, packageSchema, taskPacketSchema, taskResultSchema, type HumanHarnessPackage, type HumanHarnessTaskResult } from '../protocol/v1';
import { coordinationSettingsSchema, requirementSchema } from '../protocol/coordination';
import { enabledWorkOrders, workOrderHandoffTarget } from './work-orders';
import { planSettingsSchema, type PlanSettings } from '../protocol/planning';
import { projectSetupSchema } from '../protocol/project-launch';
import { capturePlanBaseline } from './project-plan';
import { projectLedgerCommandSchema, type ProjectLedger } from '../protocol/project-ledger';
import { externalWaits, ledgerReferenceExists, ledgerSummary } from './project-ledger';
import { readyAgentSteps } from './planning-work';
import type { SemanticNote } from '../protocol/semantics';
import type { MethodCheckResult } from '../executors/contracts';
import {
  amendAndApproveAgent, answerHumanRequest, applyHumanStep, attachHumanRequestArtifact, createTaskPacket, expireAbandonedRun, failAgent, finishAgent, freshId, holdAgentForHuman, newProject, now, receiveMaterial, reviseApprovedOutput,
  affectedStepsForOutput, invalidateSteps, reconcile, recordEvent, reserveAgent, retryAgent, reviewAgent, reviewMaterial,
  executionPolicy, type ProjectState, type RuntimeArtifact
} from './runtime';

export class RuntimeError extends Error {}
export class LedgerConflictError extends RuntimeError {}
const dir = process.env.HH_DATA_DIR ? resolve(process.env.HH_DATA_DIR) : join(process.cwd(), '.human-harness');
mkdirSync(dir, { recursive: true });
const db = new Database(join(dir, 'protocol-v1.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec([
  'CREATE TABLE IF NOT EXISTS packages (id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, definition TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, version))',
  'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, package_id TEXT NOT NULL, package_version TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS project_ledgers (project_id TEXT PRIMARY KEY REFERENCES projects(id), state TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS event_log (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), type TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_runtime_projects ON projects(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_runtime_events ON event_log(project_id, created_at)'
].join(';') + ';');

const builtinPackages = [documentHandoff, generalReport, projectPlan, meetingActions, projectRetrospective, technicalSpecReview]
  .map(pkg => packageSchema.parse(pkg));
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const asError = (e: unknown) => e instanceof Error ? e : new Error(String(e));

export function listPackages() {
  const custom = db.prepare('SELECT id, version, definition FROM packages ORDER BY created_at DESC').all() as Array<{ id: string; version: string; definition: string }>;
  const selected = new Map<string, HumanHarnessPackage>();
  for (const item of builtinPackages) selected.set(item.id, item);
  for (const row of custom) {
    const pkg = packageSchema.parse(JSON.parse(row.definition));
    if (!selected.has(pkg.id)) selected.set(pkg.id, pkg);
  }
  return [...selected.values()].map(pkg => ({
    id: pkg.id, version: pkg.version, title: pkg.title, description: pkg.description,
    stages: pkg.stages.length, materials: pkg.materials.length, steps: pkg.steps.length,
    builtin: builtinPackages.some(item => item.id === pkg.id)
  }));
}

export function getPackage(id: string, version?: string): HumanHarnessPackage {
  const known = builtinPackages.find(item => item.id === id && (!version || version === item.version));
  if (known) return known;
  const row = version
    ? db.prepare('SELECT definition FROM packages WHERE id = ? AND version = ?').get(id, version) as { definition: string } | undefined
    : db.prepare('SELECT definition FROM packages WHERE id = ? ORDER BY created_at DESC LIMIT 1').get(id) as { definition: string } | undefined;
  if (!row) throw new RuntimeError('Project package not found');
  return packageSchema.parse(JSON.parse(row.definition));
}

export function importPackage(raw: unknown) {
  const pkg = packageSchema.parse(raw);
  if (builtinPackages.some(item => item.id === pkg.id)) throw new RuntimeError('Built-in package ID cannot be overwritten');
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
  const allowedKinds = new Map([
    ['mastra.agent', 'agent'],
    ['hh.render.markdown', 'script']
  ]);
  const errors: string[] = [];
  for (const cap of pkg.capabilities) {
    const kind = allowedKinds.get(cap.id);
    if (!kind || cap.kind !== kind) {
      errors.push(cap.id + ': capability not installed or declared with incorrect kind');
    }
  }
  if (pkg.assets.length) errors.push('Asset bundles are not installed by the current JSON-only runtime');
  for (const step of pkg.steps.filter(s => s.kind === 'script')) {
    if (step.capabilityId !== 'hh.render.markdown') {
      errors.push(step.id + ': unsupported deterministic script capability');
    }
    const output = pkg.outputs.find(o => o.id === step.outputContractId);
    if (!output || output.format !== 'markdown' || output.audience !== 'internal') {
      errors.push(step.id + ': Markdown assembly only supports an internal Markdown output contract');
    }
    if (step.needsMaterials.length) {
      errors.push(step.id + ': deterministic Markdown assembly only accepts approved upstream outputs');
    }
  }
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

function loadLedger(projectId: string): ProjectLedger {
  const row = db.prepare('SELECT state FROM project_ledgers WHERE project_id = ?').get(projectId) as { state: string } | undefined;
  return row ? JSON.parse(row.state) as ProjectLedger : { revision: 0, settings: { currency: 'CNY' }, entries: [] };
}

function ledgerView(project: ProjectState, ledger: ProjectLedger) {
  const waits = externalWaits(project, new Date());
  return { ledger, waits, summary: ledgerSummary(ledger, waits) };
}

export function getProjectLedger(projectId: string) {
  return db.transaction(() => ledgerView(loadProject(projectId), loadLedger(projectId)))();
}

export type ProjectLedgerView = ReturnType<typeof getProjectLedger>;

export function getCompanyLedger() {
  const rows = db.prepare(`SELECT p.id, p.title, p.package_id, p.package_version, l.state AS ledger_state
    FROM projects p LEFT JOIN project_ledgers l ON p.id = l.project_id ORDER BY p.created_at DESC`).all() as Array<{
      id: string; title: string; package_id: string; package_version: string; ledger_state: string | null;
    }>;
  const projects = rows.map(({ ledger_state, ...project }) => {
    const ledger = ledger_state ? JSON.parse(ledger_state) as ProjectLedger : undefined;
    const summary = ledger ? ledgerSummary(ledger, []) : undefined;
    return { ...project, currency: ledger?.settings.currency, summary: summary && {
      cash: summary.cash, cashCostCents: summary.cashCostCents, cashBalanceCents: summary.cashBalanceCents,
      openReceivableCents: summary.openReceivableCents, knownCostCents: summary.knownCostCents,
      unpricedMinutes: summary.unpricedMinutes
    } };
  });
  type Totals = {
    currency: ProjectLedger['settings']['currency'];
    clients: number; paid: number; balance: number; receivable: number; missingContract: number;
  };
  const totals = new Map<Totals['currency'], Totals>();
  for (const { currency, summary } of projects) {
    if (!currency || !summary) continue;
    const group = totals.get(currency) ?? {
      currency, clients: 0, paid: 0, balance: 0, receivable: 0, missingContract: 0
    };
    group.clients += summary.cash.client;
    group.paid += summary.cashCostCents;
    group.balance += summary.cashBalanceCents;
    group.receivable += summary.openReceivableCents ?? 0;
    group.missingContract += Number(summary.openReceivableCents === undefined);
    totals.set(currency, group);
  }
  return { projects, totals: [...totals.values()] };
}

export type CompanyLedgerView = ReturnType<typeof getCompanyLedger>;


export function updateProjectLedger(projectId: string, input: unknown) {
  const command = projectLedgerCommandSchema.parse(input);
  return db.transaction(() => {
    const project = loadProject(projectId);
    const ledger = loadLedger(projectId);
    if (command.action === 'record') {
      const existing = ledger.entries.find(entry => entry.id === command.entry.id);
      if (existing) {
        const { recordedAt: _recordedAt, hourlyRateCents: _hourlyRateCents, voided: _voided, ...original } = existing;
        if (JSON.stringify(original) === JSON.stringify(command.entry)) return ledgerView(project, ledger);
        throw new LedgerConflictError('这笔账的提交编号已使用，请刷新后重试。');
      }
    }
    if (ledger.revision !== command.revision) throw new LedgerConflictError('项目账务已更新，请刷新账务后重试。');
    switch (command.action) {
      case 'settings':
        if (command.settings.currency !== ledger.settings.currency && (ledger.entries.length || ledger.baseline?.cashCostCents !== undefined)) {
          throw new RuntimeError('项目已有金额记录，币种已锁定。');
        }
        ledger.settings = command.settings;
        break;
      case 'record':
        if (command.entry.reference && !ledgerReferenceExists(project, command.entry.reference)) {
          throw new RuntimeError('关联事项不属于当前项目。');
        }
        ledger.entries.push({
          ...command.entry, recordedAt: now(),
          ...(command.entry.type === 'labor' && ledger.settings.hourlyRateCents !== undefined
            ? { hourlyRateCents: ledger.settings.hourlyRateCents } : {})
        });
        break;
      case 'void': {
        const entry = ledger.entries.find(item => item.id === command.entryId);
        if (!entry || entry.voided) throw new RuntimeError('这笔账不存在或已作废。');
        entry.voided = { at: now(), reason: command.reason };
        break;
      }
      case 'baseline':
        ledger.baseline = command.baseline ?? undefined;
        break;
    }
    ledger.revision++;
    db.prepare('INSERT INTO project_ledgers (project_id, state) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET state = excluded.state')
      .run(projectId, JSON.stringify(ledger));
    return ledgerView(project, ledger);
  }).immediate();
}


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

function buildProjectSnapshot(packageId: string, rawTitle: string, rawSetup?: unknown, version?: string): ProjectState {
  const title = rawTitle.trim();
  if (!title || title.length > 150) throw new RuntimeError('Project title must be between 1 and 150 characters');
  const pkg = getPackage(packageId, version);
  const readiness = inspectReadiness(pkg);
  if (readiness.errors.length) throw new RuntimeError(readiness.errors.join('; '));
  const setup = rawSetup === undefined ? undefined : projectSetupSchema.parse(rawSetup);
  if (setup) {
    validatePlanScope(pkg, setup.planning);
    validateRequirements(pkg, setup.requirements);
  }
  return newProject(pkg, freshId(), title, digest(pkg), setup && {
    planning: { revision: 1, settings: setup.planning },
    ...((pkg.workOrders?.length ?? 0) > 0 ? {
      coordination: { revision: 1, timeZone: setup.planning.timeZone, requirements: setup.requirements }
    } : {})
  });
}

export function previewProject(packageId: string, title: string, setup?: unknown, version?: string) {
  return buildProjectSnapshot(packageId, title, setup, version);
}

export function createProject(packageId: string, rawTitle: string, setup?: unknown, version?: string): ProjectState {
  const project = buildProjectSnapshot(packageId, rawTitle, setup, version);
  db.transaction(() => {
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run(
      project.id, project.title, project.templateId, project.templateVersion, JSON.stringify(project), project.createdAt
    );
    for (const e of project.events) {
      db.prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?, ?)').run(
        e.id, project.id, e.type, e.subject, e.detail, e.createdAt
      );
    }
  })();
  return project;
}

/** Project-scoped, durable dispatch policy. Pause affects future starts, not active runs. */
export function setExecutionPolicy(id: string, autoDispatch: boolean, maxParallel: number) {
  if (typeof autoDispatch !== 'boolean' || !Number.isInteger(maxParallel) ||
      maxParallel < 1 || maxParallel > 4) {
    throw new RuntimeError('Invalid execution policy (autoDispatch boolean, maxParallel 1–4)');
  }
  return mutate(id, project => {
    const current = project.execution;
    if (current?.autoDispatch === autoDispatch && current.maxParallel === maxParallel) return;
    project.execution = { autoDispatch, maxParallel };
    recordEvent(project, 'execution.policy_changed', project.id,
      (autoDispatch ? 'auto' : 'paused') + ': ' + maxParallel);
  }).project;
}

function validatePlanScope(pkg: HumanHarnessPackage, settings: PlanSettings, requestIds: string[] = []) {
  const taskKeys = new Set(pkg.materials.map(material => 'material:' + material.id));
  const decisions = new Map(pkg.steps.filter(step => step.kind === 'human_decision')
    .map(step => [step.id, step.options ?? []]));
  for (const step of pkg.steps) {
    taskKeys.add('step:' + step.id);
    if (step.kind === 'agent' || step.kind === 'script') taskKeys.add('review:' + step.id);
  }
  for (const id of requestIds) taskKeys.add('request:' + id);
  if ([...Object.keys(settings.estimates), ...Object.keys(settings.taskDueDates ?? {}), ...settings.expedited].some(key => !taskKeys.has(key))) {
    throw new RuntimeError('计划包含未知任务。');
  }
  for (const [stepId, option] of Object.entries(settings.assumptions)) {
    if (!decisions.get(stepId)?.some(choice => choice.id === option)) {
      throw new RuntimeError('计划分支选项无效。');
    }
  }
}

function validateRequirements(pkg: HumanHarnessPackage, requirements: Record<string, unknown>) {
  if (Object.keys(requirements).some(id => !(pkg.workOrders ?? []).some(order => order.id === id))) {
    throw new RuntimeError('项目模板未定义这项工作。');
  }
}

export function saveProjectPlan(id: string, expectedRevision: number, rawPlan: unknown, freeze: boolean) {
  const settings = planSettingsSchema.parse(rawPlan);
  return mutate(id, project => {
    const previous = project.planning;
    if (expectedRevision !== (previous?.revision ?? 0)) {
      throw new RuntimeError('项目计划已更新，请载入最新设置后再保存。');
    }
    validatePlanScope(project.package, settings, (project.humanRequests ?? []).map(request => request.id));
    if (previous?.baseline && previous.baseline.timeZone !== settings.timeZone && !freeze) {
      throw new RuntimeError('切换时区时请同时重新锁定基准。');
    }
    let baseline = previous?.baseline;
    if (freeze) {
      try { baseline = capturePlanBaseline(project, settings, new Date()); }
      catch (error) { throw new RuntimeError(asError(error).message); }
    }
    project.planning = { revision: expectedRevision + 1, settings, ...(baseline ? { baseline } : {}) };
    recordEvent(project, freeze ? 'plan.baseline_captured' : 'plan.updated', project.id, JSON.stringify({
      revision: project.planning.revision, target: settings.due, humanMinutes: settings.humanMinutes,
      humanLanes: settings.humanLanes, externalLanes: settings.externalLanes, agentMinutes: settings.agentMinutes,
      externalMinutes: settings.externalMinutes, restrictAgentStarts: settings.restrictAgentStarts,
      expedited: settings.expedited
    }));
  }).project;
}

export function saveProjectCoordination(id: string, expectedRevision: number, raw: unknown) {
  const next = coordinationSettingsSchema.parse(raw);
  return mutate(id, project => {
    const previous = project.coordination;
    if (expectedRevision !== (previous?.revision ?? 0)) {
      throw new RuntimeError('项目要求已更新，请重新载入。');
    }
    const declared = project.package.workOrders ?? [];
    validateRequirements(project.package, next.requirements);
    project.coordination = { ...next, revision: expectedRevision + 1 };
    const changed = declared.filter(order => Object.hasOwn(previous?.requirements ?? {}, order.id) !==
      Object.hasOwn(next.requirements, order.id));
    const affected = new Set(changed.flatMap(order => order.consumers));
    for (const root of [...affected]) {
      for (const child of affectedStepsForOutput(project, root)) affected.add(child);
    }
    invalidateSteps(project, affected, 'Work orders changed: ' + changed.map(order => order.id).join(', '),
      'Dependent Agent work is active; finish or cancel it before changing work orders');
    recordEvent(project, 'work_order.scope_saved', project.id, JSON.stringify(next.requirements));
  }).project;
}

export function recordWorkOrderFollowUp(id: string, stepId: string, raw: string, promisedOn?: string) {
  const note = raw.trim();
  if (!note || note.length > 1000) throw new RuntimeError('请填写 1–1000 字的实际跟进记录。');
  return mutate(id, project => {
    if (project.steps[stepId]?.state !== 'ready' ||
        !enabledWorkOrders(project).some(order => order.followUp?.milestoneId === stepId)) {
      throw new RuntimeError('该事项当前无需跟进。');
    }
    recordEvent(project, 'work_order.follow_up', stepId, note);
    if (promisedOn) recordEvent(project, 'work_order.promise', stepId, requirementSchema.shape.due.parse(promisedOn));
  }).project;
}

export function answerRequestedInput(id: string, requestId: string, value: string) {
  if (!value.trim()) throw new RuntimeError('Human answer is required');
  if (value.length > 8000) throw new RuntimeError('Human answer is too long');
  return mutate(id, project => answerHumanRequest(project, requestId, value)).project;
}

export function awaitHumanInput(id: string, stepId: string, runId: string, rawResult: unknown,
  requests: readonly { materialId: string; reason: string }[]) {
  const result = taskResultSchema.parse(rawResult);
  return mutate(id, project => holdAgentForHuman(project, stepId, runId, result, requests)).project;
}

export function completeHuman(id: string, stepId: string, value: string, promisedOn?: string) {
  if (value.length > 8000) throw new RuntimeError('Human input is too long');
  return mutate(id, p => {
    const milestoneId = promisedOn ? workOrderHandoffTarget(p, stepId) : undefined;
    if (promisedOn && !milestoneId) throw new RuntimeError('该任务没有可记录的外部回件日期。');
    applyHumanStep(p, stepId, value);
    if (milestoneId && promisedOn) {
      recordEvent(p, 'work_order.promise', milestoneId, requirementSchema.shape.due.parse(promisedOn));
    }
  }).project;
}

export type UploadInput = { name: string; buffer: Buffer } | undefined;
const textExtensions = new Set(['.txt', '.md', '.json', '.csv', '.geojson', '.kml', '.yaml', '.yml']);
export function submitMaterial(id: string, materialId: string, rawText: string, upload?: UploadInput,
  options: { replaceAccepted?: boolean; requestId?: string } = {}): ProjectState {
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
      if (options.requestId) {
        const request = p.humanRequests?.find(req => req.id === options.requestId);
        if (!request || request.status !== 'pending' || request.materialId !== materialId ||
            p.steps[request.stepId]?.state !== 'waiting_input') {
          throw new RuntimeError('Human file request is not pending or material is mismatched');
        }
        if (!upload) throw new RuntimeError('File attachment is required to answer with a new original');
      }
      if (options.replaceAccepted && !['accepted', 'rejected'].includes(p.materials[materialId]?.state)) {
        throw new RuntimeError('Only accepted or rejected materials can be replaced');
      }
      if (!upload && !def.formats.includes('text/plain')) {
        throw new RuntimeError('This requirement needs an original file; text notes alone are insufficient');
      }
      const name = upload ? basename(upload.name).slice(0, 150) || 'upload' : '用户文本说明';
      const isTextFile = Boolean(upload && textExtensions.has(extname(name).toLowerCase()));
      if (upload && !def.formats.some(x => x !== 'text/plain') &&
          !(def.formats.includes('text/plain') && isTextFile)) {
        throw new RuntimeError('This requirement accepts text uploads only, not binary files');
      }
      const readable = upload && isTextFile ? upload.buffer.toString('utf8') : null;
      if (readable !== null && readable.length > 30000) {
        throw new RuntimeError('Text file exceeds 30,000 characters; submit a smaller document');
      }
      const artifact: RuntimeArtifact = {
        id: artifactId, kind: 'material', name,
        // A source file's bytes are authoritative. Human notes cannot replace
        // the uploaded body or turn an unread PDF into readable content.
        content: upload ? readable : content, ownerId: materialId,
        revision: p.materials[materialId].artifactIds.length + 1, createdAt: now(),
        ...(upload && content ? { submissionNote: content } : {}),
        ...(filePath ? { filePath } : {})
      };
      receiveMaterial(p, materialId, artifact, Boolean(options.replaceAccepted || options.requestId));
      if (options.requestId) attachHumanRequestArtifact(p, options.requestId, artifact.id, content);
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
      : readyAgentSteps(p)[0];
    if (!step) throw new RuntimeError('No ready Agent task');
    if (p.steps[step.id]?.state !== 'ready') throw new RuntimeError('Agent work item is not ready');
    // Enforce project capacity in the same SQLite transaction as run reservation.
    // A second app worker cannot bypass the limit by reading a stale UI snapshot.
    const running = Object.values(p.steps).filter(state => state.state === 'running').length;
    if (running >= executionPolicy(p).maxParallel) {
      throw new RuntimeError('Project Agent concurrency limit reached');
    }
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
  event: { kind: 'thread'; id: string } | { kind: 'turn'; id: string } | { kind: 'progress'; message: string }) {
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

export function succeedAgent(id: string, stepId: string, runId: string, rawResult: unknown, output: string,
  semanticNotes: readonly SemanticNote[] = [], methodChecks: readonly MethodCheckResult[] = []) {
  const result = taskResultSchema.parse(rawResult);
  return mutate(id, p => {
    const step = p.package.steps.find(s => s.id === stepId);
    if (!step) throw new RuntimeError('Unknown producing step');
    const contract = p.package.outputs.find(o => o.id === step.outputContractId);
    const maxLength = contract?.markdown?.assembly === 'concatenate' ? MAX_ASSEMBLED_MARKDOWN_LENGTH : 120000;
    if (!output.trim() || output.length > maxLength) throw new RuntimeError('Agent returned empty or oversized output');
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
      createdAt: now(),
      ...(semanticNotes.length ? { semanticNotes: [...semanticNotes] } : {}),
      ...(methodChecks.length ? { methodChecks: [...methodChecks] } : {})
    };
    finishAgent(p, stepId, runId, result, artifact);
  }).project;
}

export const reviewAgentOutput = (id: string, stepId: string, accepted: boolean, feedback: string) =>
  mutate(id, p => reviewAgent(p, stepId, accepted, feedback)).project;
/** Atomic audit trail: retain the Agent original, add corrected Human version, then approve. */
export const approveHumanCorrectedOutput = (id: string, stepId: string, content: string, rationale: string) =>
  mutate(id, p => amendAndApproveAgent(p, stepId, content, rationale)).project;
/** Strict compare-and-swap against observed approved HEAD; descendants are invalidated atomically. */
export const reviseHumanApprovedOutput = (id: string, stepId: string, expectedHead: string,
  content: string, rationale: string) =>
  mutate(id, p => reviseApprovedOutput(p, stepId, expectedHead, content, rationale)).project;
export const markAgentFailed = (id: string, stepId: string, runId: string, error: string) =>
  mutate(id, p => failAgent(p, stepId, runId, error)).project;
export const retryFailedAgent = (id: string, stepId: string) =>
  mutate(id, p => retryAgent(p, stepId)).project;
export const recoverAbandonedAgent = (id: string, stepId: string) =>
  mutate(id, p => expireAbandonedRun(p, stepId)).project;

/**
 * Single-process local worker startup only: a prior process cannot still
 * own this server's child tasks. Do not auto-retry them; require human review.
 * This is NOT a multi-server lease recovery protocol.
 */
export function interruptOrphanedRuns(): number {
  let interrupted = 0;
  for (const row of listProjects()) {
    const project = getProject(row.id);
    const stale = project.package.steps.filter(step =>
      (step.kind === 'agent' || step.kind === 'script') &&
      project.steps[step.id]?.state === 'running'
    );
    if (!stale.length) continue;
    mutate(row.id, p => {
      for (const step of stale) {
        const runId = p.steps[step.id]?.runId;
        if (!runId || p.steps[step.id]?.state !== 'running') continue;
        failAgent(p, step.id, runId,
          'Local worker stopped before the result was saved. Inspect the task before allowing a retry.');
        recordEvent(p, 'run.interrupted', step.id, runId);
        interrupted++;
      }
    });
  }
  return interrupted;
}

export function latestOutput(project: ProjectState, stepId: string) {
  return project.artifacts.filter(a => a.kind === 'agent_output' && a.ownerId === stepId).at(-1);
}
