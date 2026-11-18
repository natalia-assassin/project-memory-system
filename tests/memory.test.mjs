import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, ID, log, message } from './helpers.mjs';
import { importData } from '../scripts/lib/importers.mjs';
import { context, memoryStatus, recordMemory, search } from '../scripts/lib/memory.mjs';
import { readState } from '../scripts/lib/storage.mjs';

const cli = fileURLToPath(new URL('../scripts/project-memory.mjs', import.meta.url));
const source = messageId => ({ threadId: ID, hostId: 'local', messageId });
async function seed(t) {
  const f = await fixture(t);
  await log(f.home, f.root, { records: [message('u1', 'user', '项目必须以人民币结算。', 1), message('u2', 'user', '现在改为美元结算。', 2), message('a1', 'assistant', '建议使用欧元。', 3), { type: 'response_item', ordinal: 4, payload: { type: 'function_call_output', call_id: 'test', output: '测试已通过' } }] });
  await importData(f.project);
  return f;
}

export function child(args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, ...args], { windowsHide: true, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => { stdout += data; }); proc.stderr.on('data', data => { stderr += data; });
    proc.on('error', reject);
    proc.on('close', code => resolve({ code, stdout, stderr }));
    proc.stdin.end(input ? JSON.stringify(input) : undefined);
  });
}

test('聊天甲的需求可被聊天乙检索并追溯原文，摘要断点可恢复', async t => {
  const { project } = await seed(t);
  await recordMemory(project, { sessionId: ID, turnId: 'turn-a', records: [{ id: 'currency', type: 'requirement', key: 'billing.currency', text: '结算使用人民币。', status: 'confirmed', sources: [source('u1')] }], processed: [{ threadId: ID, messageIds: ['u1'] }] });
  const loaded = await context(project, { query: '结算' });
  assert.match(loaded.text, /人民币/);
  assert.match(loaded.text, new RegExp(`${ID}#u1`));
  const hit = (await search(project, { query: '人民币', kind: 'memory' })).results[0];
  assert.equal(hit.id, 'currency');
  const original = await search(project, { threadId: hit.sources[0].threadId, messageId: hit.sources[0].messageId });
  assert.equal(original.text, '项目必须以人民币结算。');
  assert.equal((await context(project, { pending: true })).totalPending, 2);
  assert.ok((await readState(project)).receipts[`${ID}:turn-a`]);
});

test('保留未解决的冲突，明确替代后保留旧决定历史', async t => {
  const { project } = await seed(t);
  await recordMemory(project, { records: [{ id: 'rmb', type: 'decision', key: 'currency', text: '使用人民币', status: 'confirmed', sources: [source('u1')] }, { id: 'usd', type: 'decision', key: 'currency', text: '使用美元', status: 'confirmed', sources: [source('u2')] }] });
  assert.equal((await memoryStatus(project)).冲突条数, 2);
  assert.match((await context(project)).text, /conflict/);
  await recordMemory(project, { records: [{ id: 'resolved', type: 'decision', key: 'currency', text: '最新确认使用美元', status: 'confirmed', supersedes: ['rmb', 'usd'], sources: [source('u2')] }] });
  assert.equal((await memoryStatus(project)).冲突条数, 0);
  const history = await search(project, { query: '人民币', kind: 'memory', includeHistory: true });
  assert.equal(history.results[0].effectiveStatus, 'superseded');
  assert.doesNotMatch((await context(project)).text, /使用人民币/);
});

test('助手建议不能冒充用户确认或替代已确认决定', async t => {
  const { project } = await seed(t);
  await assert.rejects(recordMemory(project, { records: [{ type: 'decision', key: 'currency', text: '欧元', status: 'confirmed', sources: [source('a1')] }] }), /用户消息/);
  await recordMemory(project, { records: [{ id: 'rmb', type: 'decision', key: 'currency', text: '人民币', status: 'confirmed', sources: [source('u1')] }] });
  await assert.rejects(recordMemory(project, { records: [{ type: 'decision', key: 'currency', text: '欧元', status: 'proposed', supersedes: ['rmb'], sources: [source('a1')] }] }), /不能替代/);
  await recordMemory(project, { records: [{ id: 'proposal', type: 'decision', key: 'currency', text: '欧元', status: 'proposed', sources: [source('a1')] }] });
  assert.equal((await memoryStatus(project)).冲突条数, 0);
});

test('来源不存在、原地改写及无效处理断点都拒绝，事务不留半条记忆', async t => {
  const { project } = await seed(t);
  await assert.rejects(recordMemory(project, { records: [{ id: 'valid', type: 'todo', text: '有效条目', sources: [source('u1')] }, { type: 'todo', text: '虚构条目', sources: [source('missing')] }] }), /来源不存在/);
  assert.equal(Object.keys((await readState(project)).memories).length, 0);
  await recordMemory(project, { records: [{ id: 'valid', type: 'todo', text: '有效条目', sources: [source('u1')] }] });
  await assert.rejects(recordMemory(project, { records: [{ id: 'valid', type: 'todo', text: '悄悄改写', sources: [source('u1')] }] }), /不能直接改写/);
  await assert.rejects(recordMemory(project, { noChanges: true, processed: [{ threadId: ID, messageIds: ['missing'] }] }), /不存在/);
});

test('独立进程并发保存不会覆盖其他聊天的更新', async t => {
  const { root, project } = await seed(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => child(['record', '--project', root, '--input', '-'], { input: { sessionId: ID, turnId: `parallel-${index}`, records: [{ id: `parallel-${index}`, type: 'todo', key: `task-${index}`, text: `并发任务 ${index}`, sources: [source('u1')] }] } })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const state = await readState(project);
  assert.equal(Object.keys(state.memories).length, 8);
  assert.equal(Object.keys(state.receipts).length, 8);
});

test('重复写入同一记忆不重复；无新增凭据不吞掉待整理历史', async t => {
  const { project } = await seed(t);
  const input = { records: [{ type: 'todo', key: 'followup', text: '补充验收', sources: [source('u1')] }] };
  await recordMemory(project, input); await recordMemory(project, input);
  await recordMemory(project, { sessionId: ID, turnId: 'unchanged', noChanges: true });
  assert.equal((await memoryStatus(project)).记忆条数, 1);
  assert.equal((await context(project, { pending: true })).totalPending, 3);
});

test('命令行只读限制、参数失败与标准输入 JSON', async t => {
  const { root, project } = await seed(t);
  const before = await fs.readFile(path.join(project.dir, 'state.json'), 'utf8');
  const denied = await child(['record', '--project', root, '--input', '-'], { env: { PROJECT_MEMORY_READ_ONLY: '1' }, input: { noChanges: true } });
  assert.equal(denied.code, 1); assert.match(denied.stderr, /只读/);
  assert.equal(await fs.readFile(path.join(project.dir, 'state.json'), 'utf8'), before);
  assert.equal((await child(['search', '--project', root, '--limit', '-1'])).code, 1);
  const accepted = await child(['record', '--project', root, '--input', '-'], { input: { noChanges: true } });
  assert.equal(accepted.code, 0, accepted.stderr);
});

test('无效记忆数组字段及危险标识不污染已保存数据', async t => {
  const { project } = await seed(t);
  await assert.rejects(recordMemory(project, { records: [{ type: 'todo', text: '错误数组', topics: '不是数组', sources: [source('u1')] }] }), /字符串数组/);
  await assert.rejects(recordMemory(project, { records: [{ id: '__proto__', type: 'todo', text: '错误标识', sources: [source('u1')] }] }), /id 无效/);
  assert.equal(Object.keys((await readState(project)).memories).length, 0);
});

test('已有替代关系不能被重写成循环', async t => {
  const { project } = await seed(t);
  await recordMemory(project, { records: [{ id: 'a', type: 'decision', key: 'currency', text: '人民币', status: 'confirmed', sources: [source('u1')] }] });
  await recordMemory(project, { records: [{ id: 'b', type: 'decision', key: 'currency', text: '美元', status: 'confirmed', supersedes: ['a'], sources: [source('u2')] }] });
  await assert.rejects(recordMemory(project, { records: [{ id: 'a', type: 'decision', key: 'currency', text: '人民币', status: 'confirmed', supersedes: ['b'], sources: [source('u1')] }] }), /不能直接改写/);
  assert.equal((await memoryStatus(project)).冲突条数, 0);
  assert.match((await context(project)).text, /美元/);
});
