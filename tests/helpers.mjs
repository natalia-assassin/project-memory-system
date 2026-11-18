import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../scripts/lib/integration.mjs';
import { loadProject } from '../scripts/lib/storage.mjs';

const base = fileURLToPath(new URL('../.tmp/tests/', import.meta.url));
export const ID = '11111111-1111-4111-8111-111111111111';
export const BRANCH = '22222222-2222-4222-8222-222222222222';
export const BRANCH2 = '33333333-3333-4333-8333-333333333333';

export async function fixture(t, options = {}) {
  await fs.mkdir(base, { recursive: true });
  const temp = await fs.mkdtemp(path.join(base, '项目记忆-'));
  t.after(async () => {
    const resolved = path.resolve(temp);
    if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error('测试清理路径超出隔离目录。');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const root = path.join(temp, '旧项目 中文 空格'), home = path.join(temp, 'codex');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  if (options.beforeInstall) await options.beforeInstall(root, home);
  if (!options.noInstall) await install({ project: root, codexHome: home, desktopProjectId: 'project-a' });
  const project = options.noInstall ? null : await loadProject(root);
  return { temp, root, home, project };
}

export const message = (id, role, text, ordinal, extra = {}) => ({ type: 'response_item', ordinal, timestamp: `2026-11-18T00:00:${String(ordinal).padStart(2, '0')}.000Z`, payload: { type: 'message', id, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra } });

export async function log(home, root, { id = ID, branch, timestamp = '2026-11-18T00:00:00.000Z', base: historyBase, records = [], archived = false, broken = '', name, firstOrdinal = 0, source = 'cli', threadSource } = {}) {
  const folder = path.join(home, archived ? 'archived_sessions' : 'sessions', '2026', '11', '18');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, name ?? `rollout-${id}${branch ? `_${branch}` : ''}.jsonl`);
  const head = { type: 'session_meta', ordinal: firstOrdinal, timestamp, payload: { id, session_id: id, cwd: root, timestamp, source, thread_source: threadSource, cli_version: '0.169.0', ...(historyBase ? { history_base: historyBase } : {}) } };
  await fs.writeFile(file, [head, ...records].map(value => JSON.stringify(value)).join('\n') + '\n' + broken);
  return file;
}

export function envelope(root, { runId = 'run-one', nextCursor = null, cursor = null, archived = false, threadId = ID, title = '原始聊天标题', pages = true, messages = true } = {}) {
  return {
    schemaVersion: 1, projectId: 'project-a', runId,
    inventoryPages: pages ? [{ archived, cursor, data: { threads: [{ id: threadId, hostId: 'local', projectId: 'project-a', cwd: root, title }], nextCursor } }] : [],
    threadPages: messages ? [{ cursor, data: { thread: { id: threadId, hostId: 'local', cwd: root, title }, page: { order: 'newest_first', nextCursor, hasMore: Boolean(nextCursor) }, turns: [{ id: 'turn-one', startedAt: 1794960000, items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: '项目结算必须使用人民币。' }] }, { type: 'reasoning', id: 'hidden', summary: ['不应导入的推理'] }, { type: 'agentMessage', id: 'a1', phase: 'final', text: '已经记录结算要求。' }] }] } }] : []
  };
}
