import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { Artifact, Project, Task } from './domain';
import { canStart, nextReadyAgentTask, validateDeliverableContent } from './domain';
import { templates } from './templates';
import { parseTemplate } from './template-import';
import type { ProjectTemplate } from './domain';

export class DomainError extends Error {}

const dataDir = process.env.HH_DATA_DIR ? resolve(process.env.HH_DATA_DIR) : join(process.cwd(), '.human-harness');
mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, 'projects.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec([
  'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, template_id TEXT NOT NULL, template_version INTEGER NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS tasks (project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, optional INTEGER NOT NULL, review_required INTEGER NOT NULL, input_kind TEXT, prompt TEXT, depends_on TEXT NOT NULL, PRIMARY KEY (project_id, task_id))',
  'CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, content TEXT, file_path TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS custom_templates (id TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, definition TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, version))',
  'CREATE TABLE IF NOT EXISTS project_template_snapshots (project_id TEXT PRIMARY KEY REFERENCES projects(id), definition TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, ordinal)',
  'CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, created_at)'
].join(';') + ';');

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const id = () => randomUUID();
const rows = (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params) as Row[];

function record(projectId: string, taskId: string | null, action: string, detail: string): void {
  db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run(id(), projectId, taskId, action, detail, now());
}

export function listProjects(): Array<{id: string; title: string; templateId: string; createdAt: string}> {
  return rows('SELECT id, title, template_id, created_at FROM projects ORDER BY created_at DESC').map(r => ({
    id: String(r.id), title: String(r.title), templateId: String(r.template_id), createdAt: String(r.created_at)
  }));
}

type TemplateSummary = { id: string; title: string; description: string; version: number };

export function listTemplateSummaries(): TemplateSummary[] {
  const builtin = templates.map(t => ({ id: t.id, title: t.title, description: t.description, version: t.version }));
  const custom = rows('SELECT id, title, description, MAX(version) AS version FROM custom_templates GROUP BY id ORDER BY id')
    .map(r => ({ id: String(r.id), title: String(r.title), description: String(r.description), version: Number(r.version) }));
  return [...builtin, ...custom];
}

export function addTemplate(raw: unknown): TemplateSummary {
  const template = parseTemplate(raw);
  if (templates.some(t => t.id === template.id)) throw new DomainError('Template ID belongs to a built-in template');
  db.transaction(() => {
    const latest = db.prepare('SELECT MAX(version) AS version FROM custom_templates WHERE id = ?').get(template.id) as { version: number | null };
    if (latest.version !== null && template.version <= Number(latest.version)) {
      throw new DomainError('Template version must be greater than existing version');
    }
    db.prepare('INSERT INTO custom_templates VALUES (?, ?, ?, ?, ?, ?)').run(
      template.id, template.version, template.title, template.description, JSON.stringify(template), now());
  })();
  return { id: template.id, title: template.title, description: template.description, version: template.version };
}

function findTemplate(templateId: string): ProjectTemplate {
  const builtin = templates.find(t => t.id === templateId);
  if (builtin) return builtin;
  const row = db.prepare('SELECT definition FROM custom_templates WHERE id = ? ORDER BY version DESC LIMIT 1')
    .get(templateId) as { definition: string } | undefined;
  if (!row) throw new DomainError('Unknown template');
  return parseTemplate(JSON.parse(row.definition));
}

export function createProject(templateId: string, rawTitle: string): Project {
  const template = findTemplate(templateId);
  const title = rawTitle.trim();
  if (!title || title.length > 120) throw new DomainError('Project title must be 1–120 characters');
  const projectId = id();
  db.transaction(() => {
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(projectId, title, template.id, template.version, now());
    db.prepare('INSERT INTO project_template_snapshots VALUES (?, ?)').run(projectId, JSON.stringify(template));
    const insert = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    template.tasks.forEach((t, index) => {
      insert.run(projectId, t.id, index, t.title, t.description, t.owner, 'pending',
        Number(Boolean(t.optional)), Number(Boolean(t.reviewRequired)), t.inputKind ?? null,
        t.prompt ?? null, JSON.stringify(t.dependsOn));
    });
    record(projectId, null, 'project.created', template.id + '@' + template.version);
  })();
  return getProjectOrThrow(projectId);
}

export function getProject(projectId: string): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined;
  if (!r) return null;
  const snapshot = db.prepare('SELECT definition FROM project_template_snapshots WHERE project_id = ?').get(projectId) as { definition: string } | undefined;
  const template: ProjectTemplate | undefined = snapshot ? parseTemplate(JSON.parse(snapshot.definition)) : undefined;
  const definitions = new Map(template?.tasks.map(t => [t.id, t]) ?? []);
  const tasks: Task[] = rows('SELECT * FROM tasks WHERE project_id = ? ORDER BY ordinal', projectId).map(t => ({
    ...(definitions.get(String(t.task_id)) ?? {}),
    id: String(t.task_id), projectId, ordinal: Number(t.ordinal), title: String(t.title),
    description: String(t.description), owner: t.owner as Task['owner'], status: t.status as Task['status'],
    dependsOn: JSON.parse(String(t.depends_on)) as string[],
    optional: Boolean(t.optional), reviewRequired: Boolean(t.review_required),
    inputKind: (t.input_kind || undefined) as Task['inputKind'],
    prompt: (t.prompt || undefined) as string | undefined
  }));
  const artifacts: Artifact[] = rows('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at, rowid', projectId).map(a => ({
    id: String(a.id), projectId, taskId: String(a.task_id),
    kind: a.kind as Artifact['kind'], name: String(a.name),
    content: a.content === null ? null : String(a.content), createdAt: String(a.created_at)
  }));
  const events = rows('SELECT * FROM events WHERE project_id = ? ORDER BY created_at, rowid', projectId).map(e => ({
    id: String(e.id), taskId: e.task_id === null ? null : String(e.task_id),
    action: String(e.action), detail: String(e.detail), createdAt: String(e.created_at)
  }));
  return {
    id: String(r.id), title: String(r.title), templateId: String(r.template_id),
    templateVersion: Number(r.template_version), createdAt: String(r.created_at),
    template, tasks, artifacts, events
  };
}

function getProjectOrThrow(projectId: string): Project {
  const project = getProject(projectId);
  if (!project) throw new DomainError('Project not found');
  return project;
}

function getTask(project: Project, taskId: string): Task {
  const task = project.tasks.find(t => t.id === taskId);
  if (!task) throw new DomainError('Task not found');
  return task;
}

type Uploaded = { name: string; bytes: Buffer };
const textExtensions = new Set(['.txt', '.md', '.json', '.csv', '.geojson', '.kml', '.yaml', '.yml']);
export function submitHuman(projectId: string, taskId: string, rawText: string, uploaded?: Uploaded): Project {
  const text = rawText.trim();
  if (!text && !uploaded) throw new DomainError('Enter text or attach a file');
  if (text.length > 30000) throw new DomainError('Text exceeds 30,000 characters');
  if (uploaded && (!uploaded.bytes.length || uploaded.bytes.length > 12 * 1024 * 1024)) {
    throw new DomainError('File must be between 1 byte and 12 MB');
  }
  const project = getProjectOrThrow(projectId);
  const task = getTask(project, taskId);
  if (task.owner !== 'human' || !canStart(task, project.tasks)) throw new DomainError('Human task is not ready');
  if (task.inputKind === 'file' && !uploaded) throw new DomainError('This task requires a file');
  if (task.inputKind === 'text' && !text) throw new DomainError('This task requires text');
  const fileId = uploaded ? id() : null;
  const safeName = uploaded ? basename(uploaded.name).slice(0, 200) || 'upload' : '';
  const filePath = fileId ? join(dataDir, 'uploads', fileId) : null;
  if (uploaded && filePath) {
    const dir = join(dataDir, 'uploads');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, uploaded.bytes, { flag: 'wx' });
  }
  db.transaction(() => {
    const current = getTask(getProjectOrThrow(projectId), taskId);
    if (!canStart(current, getProjectOrThrow(projectId).tasks)) throw new DomainError('Task changed; refresh the project');
    if (text) db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id(), projectId, taskId, 'text', '用户说明', text, null, now());
    if (uploaded && filePath) {
      // Binary documents are preserved, but never misrepresented as parsed evidence.
      const ext = extname(safeName).toLowerCase();
      const readable = textExtensions.has(ext) ? uploaded.bytes.toString('utf8').slice(0, 20000) : null;
      db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(fileId, projectId, taskId, 'file', safeName, readable, filePath, now());
    }
    db.prepare("UPDATE tasks SET status = 'completed' WHERE project_id = ? AND task_id = ?").run(projectId, taskId);
    record(projectId, taskId, 'human.submitted', (text ? 'Text (' + text.length + ' chars)' : '') + (uploaded ? ' / File uploaded' : ''));
  })();
  return getProjectOrThrow(projectId);
}

export function skipHuman(projectId: string, taskId: string): Project {
  db.transaction(() => {
    const p = getProjectOrThrow(projectId);
    const t = getTask(p, taskId);
    if (t.owner !== 'human' || !t.optional || t.status !== 'pending') throw new DomainError('Task cannot be skipped');
    db.prepare("UPDATE tasks SET status = 'skipped' WHERE project_id = ? AND task_id = ?").run(projectId, taskId);
    record(projectId, taskId, 'human.skipped', '');
  })();
  return getProjectOrThrow(projectId);
}

export function reviewAgent(projectId: string, taskId: string, accepted: boolean, feedback: string): Project {
  db.transaction(() => {
    const p = getProjectOrThrow(projectId);
    const t = getTask(p, taskId);
    if (t.owner !== 'agent' || t.status !== 'review') throw new DomainError('Task is not awaiting review');
    if (!accepted && !feedback.trim()) throw new DomainError('Rejection requires feedback');
    if (feedback.length > 5000) throw new DomainError('Feedback is too long');
    db.prepare('UPDATE tasks SET status = ? WHERE project_id = ? AND task_id = ?').run(
      accepted ? 'completed' : 'pending', projectId, taskId);
    record(projectId, taskId, accepted ? 'human.approved' : 'human.rejected', feedback.trim());
  })();
  return getProjectOrThrow(projectId);
}

export function reserveAgentTask(projectId: string): Task | null {
  return db.transaction(() => {
    const project = getProjectOrThrow(projectId);
    const task = nextReadyAgentTask(project.tasks);
    if (!task) return null;
    const updated = db.prepare("UPDATE tasks SET status = 'running' WHERE project_id = ? AND task_id = ? AND status IN ('pending', 'failed')").run(projectId, task.id);
    if (updated.changes !== 1) return null;
    record(projectId, task.id, 'agent.started', '');
    return task;
  })();
}

export function finishAgent(projectId: string, taskId: string, output: string, requiresReview: boolean): Project {
  if (!output.trim()) throw new DomainError('Empty agent output');
  db.transaction(() => {
    const p = getProjectOrThrow(projectId);
    if (getTask(p, taskId).status !== 'running') throw new DomainError('Agent task is not running');
    const artifactName = validateDeliverableContent(p.template, taskId, output);
    db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id(), projectId, taskId, 'agent_result', artifactName, output.slice(0, 100000), null, now());
    db.prepare('UPDATE tasks SET status = ? WHERE project_id = ? AND task_id = ?').run(
      requiresReview ? 'review' : 'completed', projectId, taskId);
    record(projectId, taskId, requiresReview ? 'agent.review_requested' : 'agent.completed', '');
  })();
  return getProjectOrThrow(projectId);
}

export function failAgent(projectId: string, taskId: string, error: string): void {
  db.transaction(() => {
    const p = getProjectOrThrow(projectId);
    if (getTask(p, taskId).status !== 'running') return;
    db.prepare("UPDATE tasks SET status = 'failed' WHERE project_id = ? AND task_id = ?").run(projectId, taskId);
    record(projectId, taskId, 'agent.failed', error.slice(0, 800));
  })();
}
