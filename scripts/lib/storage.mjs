import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const VERSION = 1;
export const PACKAGE_VERSION = '1.1.0';
export const SKILL_NAME = 'project-memory-system';
export const MEMORY_DIR = '.project-memory';
export const now = () => new Date().toISOString();
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const threadKey = (id, hostId = 'local') => hash(`${hostId}\0${id}`).slice(0, 32);
export const messageHash = message => hash([message.role, message.kind, message.text, message.attachments ?? []]);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function exists(file) {
  try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function normalizeRoot(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('项目路径不能为空。');
  const windows = /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
  const normalized = windows ? path.win32.normalize(value).replaceAll('\\', '/').toLowerCase() : path.resolve(value).replaceAll('\\', '/');
  return normalized.replace(/\/+$/, '') || '/';
}

export const underRoot = (candidate, root) => {
  const c = normalizeRoot(candidate), r = normalizeRoot(root);
  return c === r || c.startsWith(`${r === '/' ? '' : r}/`);
};

export async function projectRoot(value) {
  if (!path.isAbsolute(value ?? '')) throw new Error('请提供已存在项目的绝对路径。');
  const root = await fs.realpath(value);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('项目路径必须是文件夹。');
  return root;
}

export async function assertNoLink(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('写入路径超出了指定项目。');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`拒绝通过符号链接或目录联接写入：${current}`); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
}

export async function readJson(file, fallback) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    if (error instanceof SyntaxError) throw new Error(`JSON 文件损坏，请保留原文件并从备份恢复：${file}`);
    throw error;
  }
}

export async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) { if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; await sleep(20 * (attempt + 1)); }
    }
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

export const writeJson = (file, value) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
export const newState = () => ({ schemaVersion: VERSION, revision: 0, memories: {}, processed: {}, receipts: {}, followups: {}, origins: {}, inventories: {}, hooks: {}, scans: {} });

export async function loadProject(rootValue) {
  const root = await projectRoot(rootValue);
  await assertNoLink(root, path.join(root, MEMORY_DIR, 'config.json'));
  let config = await readJson(path.join(root, MEMORY_DIR, 'config.json'));
  let primary = root;
  if (config.sharedWith) {
    primary = await projectRoot(config.sharedWith);
    await assertNoLink(primary, path.join(primary, MEMORY_DIR, 'config.json'));
    const main = await readJson(path.join(primary, MEMORY_DIR, 'config.json'));
    if (main.sharedWith || main.projectId !== config.projectId || !main.roots.some(r => normalizeRoot(r) === normalizeRoot(root))) throw new Error('共享记忆关联无效，请重新接入工作树。');
    config = main;
  }
  if (config.schemaVersion !== VERSION) throw new Error('不支持此记忆配置版本，请先升级技能。');
  const dir = path.join(primary, MEMORY_DIR);
  await assertNoLink(primary, dir);
  for (const name of ['state.json', 'transcripts', 'backups', 'write.lock', 'overview.md', 'index.json']) await assertNoLink(primary, path.join(dir, name));
  return { root, primary, dir, config };
}

export async function withLock(project, action, { timeout = 5000 } = {}) {
  const lockFile = path.join(project.dir, 'write.lock');
  await assertNoLink(project.primary, lockFile);
  const token = randomUUID();
  const deadline = Date.now() + timeout;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: os.hostname(), createdAt: now() }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let old;
      try { old = await readJson(lockFile); } catch { /* 另一个进程可能尚在写入锁信息。 */ }
      if (old?.host === os.hostname() && Number.isInteger(old.pid) && old.pid > 0) {
        let dead = false;
        try { process.kill(old.pid, 0); } catch (failure) { dead = failure.code === 'ESRCH'; }
        if (dead) {
          const current = await readJson(lockFile).catch(() => null);
          if (current?.token === old.token) await fs.unlink(lockFile).catch(() => {});
          continue;
        }
      }
      if (Date.now() >= deadline) throw new Error('另一个聊天正在更新项目记忆，请稍后重试；本次内容尚未保存。');
      await sleep(30);
    }
  }
  try { return await action(); }
  finally {
    await handle.close();
    const current = await readJson(lockFile).catch(() => null);
    if (current?.token === token) await fs.unlink(lockFile);
  }
}

export async function readState(project) {
  const state = await readJson(path.join(project.dir, 'state.json'), newState());
  if (state.schemaVersion !== VERSION) throw new Error('不支持此记忆数据版本。');
  return state;
}

export async function saveState(project, state) {
  state.revision++;
  state.updatedAt = now();
  await writeJson(path.join(project.dir, 'state.json'), state);
}

export async function readThreads(project) {
  const folder = path.join(project.dir, 'transcripts');
  if (!await exists(folder)) return {};
  const threads = {};
  for (const name of (await fs.readdir(folder)).sort()) {
    if (!/^[a-f0-9]{32}\.jsonl$/.test(name)) continue;
    const file = path.join(folder, name);
    await assertNoLink(project.primary, file);
    const rows = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
    let entries;
    try { entries = rows.map(line => JSON.parse(line)); } catch { throw new Error(`原文归档损坏，请从来源重新导入或恢复备份：${name}`); }
    const header = entries.shift();
    if (header?.kind !== 'thread' || header.schemaVersion !== VERSION) throw new Error(`不支持的原文归档：${name}`);
    threads[name.slice(0, -6)] = { ...header.thread, messages: entries };
  }
  return threads;
}

export async function writeThread(project, thread) {
  const key = threadKey(thread.id, thread.hostId);
  const file = path.join(project.dir, 'transcripts', `${key}.jsonl`);
  await assertNoLink(project.primary, file);
  const { messages, ...meta } = thread;
  const header = { kind: 'thread', schemaVersion: VERSION, thread: meta };
  await atomicWrite(file, [header, ...messages].map(item => JSON.stringify(item)).join('\n') + '\n');
}

export async function belongsToProject(project, candidate) {
  if (typeof candidate !== 'string' || !project.config.roots.some(root => underRoot(candidate, root))) return false;
  // 独立接入的嵌套项目应归入自己的记忆库。
  if (path.isAbsolute(candidate) && await exists(candidate)) {
    let current = await fs.realpath(candidate);
    while (project.config.roots.some(root => underRoot(current, root))) {
      const file = path.join(current, MEMORY_DIR, 'config.json');
      if (await exists(file)) {
        const nested = await readJson(file);
        return nested.projectId === project.config.projectId;
      }
      const parent = path.dirname(current);
      if (current === parent) break;
      current = parent;
    }
  }
  return true;
}

export async function walkJsonl(folder) {
  const results = [];
  async function visit(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(file);
    }
  }
  await visit(folder);
  return results.sort();
}

export function unwrap(value) {
  if (typeof value === 'string') return JSON.parse(value);
  if (Array.isArray(value?.content)) {
    const text = value.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    try { return JSON.parse(text); } catch { throw new Error('工具结果没有包含可导入的 JSON 数据。'); }
  }
  return value;
}
