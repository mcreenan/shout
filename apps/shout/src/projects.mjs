import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, realpath, stat, readdir, rm } from 'node:fs/promises';
import { resolve, dirname, basename, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { modelInfo } from './models.mjs';
import { scenarios } from './workspace.mjs';

const MAX_DIRS = 500;
const CONTROL = /[\u0000-\u001f\u007f]/;
const FIELDS = ['name', 'testCommand', 'defaultModel'];

/** An absolute folder path; `~` and `~/…` name the user's home directory. */
export function expandPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw new Error('Enter a folder path');
  const text = value.trim();
  const expanded = text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
  if (!isAbsolute(expanded)) throw new Error(`Enter an absolute folder path: ${text}`);
  return resolve(expanded);
}
const checkName = name => {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || CONTROL.test(name)) throw new Error('Enter a project name of 1–80 characters');
  return name.trim();
};
const checkCommand = command => {
  if (typeof command !== 'string' || command.length > 2000 || command.includes('\0')) throw new Error('The test command must be text of at most 2,000 characters');
  return command.trim();
};
const checkModel = choice => {
  if (choice === null) return null;
  if (!modelInfo(choice?.model)?.efforts.includes(choice?.effort)) throw new Error(`Unknown model or effort: ${choice?.model} ${choice?.effort}`);
  return { model: choice.model, effort: choice.effort };
};
const folderKind = path => stat(path).then(info => (info.isDirectory() ? 'directory' : 'file'), () => null);

/**
 * The user's projects: folders on disk that threads work in, saved in `<stateRoot>/projects.json`.
 * A folder has at most one project. Sample projects are SHOUT's scratch copies of a scenario.
 */
export class ProjectStore {
  constructor({ stateRoot }) {
    this.file = resolve(stateRoot, 'projects.json'); this.scratchRoot = resolve(stateRoot, 'workspaces');
    this.projects = new Map(); this.missing = new Set(); this.saveQueue = Promise.resolve();
  }
  async init() {
    let saved;
    try { saved = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return this;
      if (!(error instanceof SyntaxError)) throw error;
      // Writes are atomic, so this is outside damage. Threads rebuild their projects from their folders.
      const aside = `${this.file}.unreadable-${Date.now()}`; await rename(this.file, aside);
      console.error(`Could not read ${this.file}; moved it to ${aside}`); return this;
    }
    for (const item of saved?.projects ?? []) {
      if (!/^project-[a-f0-9-]+$/.test(item?.id) || typeof item.path !== 'string' || !isAbsolute(item.path)) continue;
      this.projects.set(item.id, { name: basename(item.path) || item.path, testCommand: '', defaultModel: null, sample: null, ...item });
    }
    await Promise.all(this.list().map(project => this.check(project)));
    return this;
  }
  list() { return [...this.projects.values()]; }
  find(id) { return this.projects.get(id) ?? null; }
  get(id) { const project = this.find(id); if (!project) throw new Error('Project not found'); return project; }
  byPath(path) { return this.list().find(project => project.path === path) ?? null; }
  /** Records whether the folder is there; the result shows as `unavailable`. */
  async check(project) { if (await folderKind(project.path) === 'directory') this.missing.delete(project.id); else this.missing.add(project.id); return !this.missing.has(project.id); }
  /**
   * The project for a folder, added unless one exists (`existing`). A missing folder is reported
   * with code `workspace_missing`, or created when `createWorkspace` is set.
   */
  async add({ path, name, testCommand = '', createWorkspace = false, sample = null } = {}) {
    const target = expandPath(path);
    if (name !== undefined) name = checkName(name);
    testCommand = checkCommand(testCommand);
    if (typeof createWorkspace !== 'boolean') throw new Error('createWorkspace must be a boolean');
    if (sample !== null && !scenarios.some(item => item.id === sample)) throw new Error('Unknown scenario');
    const kind = await folderKind(target);
    if (kind === 'file') throw new Error(`Workspace must be a directory: ${target}`);
    if (!kind) {
      const known = this.byPath(target);
      if (known) { await this.check(known); return { project: known, existing: true }; }
      if (!createWorkspace) throw Object.assign(new Error(`Workspace folder does not exist: ${target}`), { code: 'workspace_missing', path: target });
      await mkdir(target, { recursive: true });
    }
    const real = await realpath(target);
    const known = this.byPath(real) ?? this.byPath(target);
    if (known) { await this.check(known); return { project: known, existing: true }; }
    const project = this.adopt({ path: real, name, testCommand, sample });
    await this.save(); return { project, existing: false };
  }
  /** Adds a project without checking the folder or saving: for threads saved before projects. */
  adopt({ path, name, testCommand = '', sample = null }) {
    const now = new Date().toISOString();
    const project = { id: `project-${randomUUID()}`, name: (name ?? (basename(path) || path)).slice(0, 80), path, testCommand, defaultModel: null, sample, createdAt: now, updatedAt: now };
    this.projects.set(project.id, project); return project;
  }
  async update(id, patch) {
    const project = this.get(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Expected a JSON object');
    const unknown = Object.keys(patch).find(key => !FIELDS.includes(key));
    if (unknown) throw new Error(`A project's ${unknown} cannot be changed`);
    const next = { ...project };
    if (patch.name !== undefined) next.name = checkName(patch.name);
    if (patch.testCommand !== undefined) next.testCommand = checkCommand(patch.testCommand);
    if (patch.defaultModel !== undefined) next.defaultModel = checkModel(patch.defaultModel);
    if (FIELDS.every(key => JSON.stringify(next[key]) === JSON.stringify(project[key]))) return project;
    next.updatedAt = new Date().toISOString();
    this.projects.set(id, next); await this.save(); return next;
  }
  /** Forgets the project. Only a sample's scratch copy is deleted from disk; `deletedFolder` says whether it was. */
  async remove(id) {
    const project = this.get(id);
    this.projects.delete(id); this.missing.delete(id); await this.save();
    const scratch = project.sample ? await this.scratchFolder(project) : null;
    if (scratch) await rm(scratch, { recursive: true, force: true });
    return { project, deletedFolder: Boolean(scratch) };
  }
  /** The real path of a sample's folder when it is a scratch copy made by SHOUT: `<stateRoot>/workspaces/<sample>-XXXXXX`. */
  async scratchFolder(project) {
    const [root, real] = await Promise.all([realpath(this.scratchRoot), realpath(project.path)].map(path => path.catch(() => null)));
    return root && real && dirname(real) === root && basename(real).startsWith(`${project.sample}-`) ? real : null;
  }
  /** Writes are serialized; each replaces the file atomically (temporary file, then rename). */
  save() {
    const payload = JSON.stringify({ version: 1, projects: this.list() }, null, 2);
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(`${this.file}.tmp`, payload, { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
    });
    return this.saveQueue;
  }
}

/**
 * Sub-folders of a folder, for choosing a project folder: names and paths of directories only (and
 * links to directories), no hidden ones, sorted, at most 500. Files are never listed or read.
 */
export async function listDirectories(value = '~') {
  const path = expandPath(value);
  const parent = dirname(path) === path ? null : dirname(path);
  const reply = { path, parent, exists: false, dirs: [], truncated: false };
  if (await folderKind(path) !== 'directory') return reply;
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return { ...reply, exists: true, error: 'This folder cannot be read' }; }
  const dirs = [];
  for (const entry of entries.filter(item => !item.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, entry.name);
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && await folderKind(child) === 'directory')) continue;
    if (dirs.length === MAX_DIRS) return { ...reply, exists: true, dirs, truncated: true };
    dirs.push({ name: entry.name, path: child });
  }
  return { ...reply, exists: true, dirs };
}
