import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, ID, BRANCH, BRANCH2, log, message, envelope } from './helpers.mjs';
import { importData } from '../scripts/lib/importers.mjs';
import { context, memoryStatus, recordMemory, search } from '../scripts/lib/memory.mjs';
import { readThreads, readState, threadKey, loadProject } from '../scripts/lib/storage.mjs';
import { install } from '../scripts/lib/integration.mjs';

test('本地导入保留可见原文、工具结果及附件引用，排除内部指令和推理，并且重复导入不重复', async t => {
  const { root, home, project } = await fixture(t);
  await log(home, root, { records: [message('u1', 'user', '使用人民币', 1), message('private', 'developer', '内部指令', 2), { type: 'response_item', ordinal: 3, payload: { type: 'reasoning', text: '内部推理' } }, message('hidden-analysis', 'assistant', '隐藏分析', 4, { phase: 'analysis' }), message('a1', 'assistant', '已记录', 5), { type: 'response_item', ordinal: 6, payload: { type: 'function_call_output', call_id: 'tool-one', output: '验证通过' } }, message('u2', 'user', '', 7, { content: [{ type: 'input_image', image_url: 'https://example.test/image.png' }] })] });
  await importData(project);
  const first = await readThreads(project);
  await importData(project);
  const threads = await readThreads(project), thread = threads[threadKey(ID)];
  assert.equal(thread.messages.length, 4);
  assert.deepEqual(thread.messages, first[threadKey(ID)].messages);
  assert.equal(thread.messages.find(item => item.id === 'u2').attachments[0].reference, 'https://example.test/image.png');
  assert.equal((await memoryStatus(project)).覆盖情况.完整导入, 1);
  assert.equal((await search(project, { query: '验证通过' })).results[0].role, 'tool');
});

test('重建有效历史引用，保留旧分支但不把旧决定带入默认上下文', async t => {
  const { root, home, project } = await fixture(t);
  await log(home, root, { records: [message('u1', 'user', '共同背景', 1), message('old', 'user', '旧决定使用美元', 2)] });
  await log(home, root, { branch: BRANCH, timestamp: '2026-11-18T00:01:00.000Z', firstOrdinal: 2, base: { thread_id: ID, end_ordinal_exclusive: 2 }, records: [message('new', 'user', '新决定使用人民币', 3)] });
  await log(home, root, { branch: BRANCH2, timestamp: '2026-11-18T00:02:00.000Z', firstOrdinal: 4, base: { thread_id: BRANCH, end_ordinal_exclusive: 4 }, records: [message('final', 'assistant', '实施人民币结算', 5)] });
  await importData(project);
  const thread = (await readThreads(project))[threadKey(ID)];
  assert.deepEqual(new Set(thread.activeIds), new Set(['u1', 'new', 'final']));
  assert.equal(thread.messages.length, 4);
  assert.equal((await search(project, { query: '美元' })).total, 0);
  assert.equal((await search(project, { query: '美元', includeHistory: true })).total, 1);
  assert.equal((await context(project, { pending: true })).totalPending, 3);
});

test('缺失基底、解析失败和未写完末行均报告部分导入，修复后可继续', async t => {
  const { root, home, project } = await fixture(t);
  const file = await log(home, root, { branch: BRANCH, base: { thread_id: ID, end_ordinal_exclusive: 2 }, records: [message('new', 'user', '新需求', 3)], broken: '{"尚未写完":' });
  await importData(project);
  let status = await memoryStatus(project);
  assert.equal(status.覆盖情况.部分导入, 1);
  assert.match(status.聊天[0].warnings.join(' '), /末行|基底/);
  await log(home, root, { records: [message('u1', 'user', '前文', 1)] });
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.slice(0, text.lastIndexOf('\n') + 1));
  await importData(project);
  status = await memoryStatus(project);
  assert.equal(status.覆盖情况.完整导入, 1);
  assert.equal(status.覆盖情况.待整理消息, 2);
});

test('项目目录边界和嵌套独立项目不串入；活动与归档目录都扫描', async t => {
  const { root, home, project, temp } = await fixture(t);
  const sibling = `${root}-other`, nested = path.join(root, '子项目');
  await fs.mkdir(sibling); await fs.mkdir(nested);
  await install({ project: nested, codexHome: home });
  await log(home, root, { records: [message('u1', 'user', '本项目', 1)] });
  await log(home, root, { id: BRANCH, archived: true, records: [message('u2', 'user', '本项目归档', 1)] });
  await log(home, sibling, { id: BRANCH2, records: [message('s', 'user', '别的项目', 1)] });
  await log(home, nested, { id: '44444444-4444-4444-8444-444444444444', records: [message('n', 'user', '嵌套独立项目', 1)] });
  await importData(project);
  const status = await memoryStatus(project);
  assert.equal(status.覆盖情况.已发现, 2);
  assert.equal(status.聊天.filter(item => item.archived).length, 1);
  assert.equal((await search(project, { query: '别的项目' })).total, 0);
  assert.equal((await readThreads(await loadProject(nested)))[threadKey(ID)], undefined);
});

test('桌面清单两种分页核对，缺页保持未完成，原文缺失聊天仍计数', async t => {
  const { root, project } = await fixture(t);
  await importData(project, { local: false, input: envelope(root, { nextCursor: 'older', messages: false }) });
  let status = await memoryStatus(project);
  assert.equal(status.桌面清单已遍历完成, false);
  assert.equal(status.覆盖情况.无法读取, 1);
  await importData(project, { local: false, input: envelope(root, { cursor: 'older' }) });
  await importData(project, { local: false, input: envelope(root, { archived: true, threadId: BRANCH, messages: false }) });
  status = await memoryStatus(project);
  assert.equal(status.桌面清单已遍历完成, true);
  assert.equal(status.覆盖情况.部分导入, 1);
  assert.equal(status.覆盖情况.无法读取, 1);
  assert.equal(status.全部已发现原文完整, false);
  assert.equal((await search(project, { query: '不应导入的推理' })).total, 0);
});

test('拒绝另一个桌面项目的导出包', async t => {
  const { root, project } = await fixture(t);
  const input = envelope(root); input.projectId = 'project-b';
  await assert.rejects(importData(project, { local: false, input }), /另一个项目/);
  assert.equal(Object.keys(await readThreads(project)).length, 0);
});

test('桌面摘要由本地原文补全后重新进入待整理队列', async t => {
  const { root, home, project } = await fixture(t);
  await importData(project, { local: false, input: envelope(root) });
  await recordMemory(project, { noChanges: true, processed: [{ threadId: ID, messageIds: ['u1', 'a1'] }] });
  assert.equal((await context(project, { pending: true })).totalPending, 0);
  await log(home, root, { records: [message('u1', 'user', '项目结算必须使用人民币。并增加完整原文的补充需求。', 1), message('a1', 'assistant', '已经记录结算要求。', 2)] });
  await importData(project);
  assert.equal((await context(project, { pending: true })).totalPending, 1);
  assert.equal((await memoryStatus(project)).覆盖情况.完整导入, 1);
});

test('长中文消息可完整分段取回，context 受字符上限约束', async t => {
  const { root, home, project } = await fixture(t);
  const original = '需求😀人民币'.repeat(1600);
  await log(home, root, { records: [message('long', 'user', original, 1)] });
  await importData(project);
  const pending = await context(project, { pending: true, maxChars: 100 });
  assert.equal(Array.from(pending.messages[0].text).length, 100);
  assert.equal(pending.messages[0].nextOffset, 100);
  let assembled = '', offset = 0;
  do {
    const page = await search(project, { threadId: ID, messageId: 'long', offset, limit: 777 });
    assembled += page.text; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(assembled, original);
  assert.ok(Array.from((await context(project, { maxChars: 80 })).text).length <= 80);
});

test('只有事件的旧版会话可导入但不宣称完整', async t => {
  const { root, home, project } = await fixture(t);
  await log(home, root, { records: [{ type: 'event_msg', ordinal: 1, payload: { type: 'user_message', message: '旧版消息' } }] });
  await importData(project);
  assert.equal((await memoryStatus(project)).覆盖情况.部分导入, 1);
  assert.equal((await search(project, { query: '旧版消息' })).total, 1);
});

test('未知可见记录不被悄悄标为完整，已知网页工具调用可检索', async t => {
  const { root, home, project } = await fixture(t);
  await log(home, root, { records: [message('u1', 'user', '搜索项目资料', 1), { type: 'response_item', ordinal: 2, payload: { type: 'web_search_call', id: 'web1', action: { query: '项目记忆' }, status: 'completed' } }, { type: 'response_item', ordinal: 3, payload: { type: 'future_visible_item', text: '新版本记录' } }] });
  await importData(project);
  assert.equal((await memoryStatus(project)).覆盖情况.部分导入, 1);
  assert.equal((await search(project, { query: '项目记忆' })).total, 1);
});

test('分页游标可包含保留单词，错误的更多页面标记不能冒充完整', async t => {
  const { root, project } = await fixture(t);
  await importData(project, { local: false, input: envelope(root, { nextCursor: '__proto__', messages: false }) });
  await importData(project, { local: false, input: envelope(root, { cursor: '__proto__', messages: false }) });
  const state = await readState(project);
  assert.equal(state.inventories.active.complete, true);
  const invalid = envelope(root, { pages: false });
  invalid.threadPages[0].data.page.hasMore = true;
  await assert.rejects(importData(project, { local: false, input: invalid }), /下一页游标/);
});

test('已登记聊天的另一项目页面仍被拒绝', async t => {
  const { root, project } = await fixture(t);
  await importData(project, { local: false, input: envelope(root, { messages: false }) });
  const invalid = envelope(root, { pages: false });
  invalid.threadPages[0].data.thread.projectId = 'other-project';
  await assert.rejects(importData(project, { local: false, input: invalid }), /另一个桌面项目/);
});

test('相同目录下的内部工作记录和自动注入的环境上下文不进入用户聊天归档', async t => {
  const { root, home, project } = await fixture(t);
  const injected = message('env', 'user', '内部环境与权限说明', 1, { internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'], content_item_metadata: [{ provenance: { type: 'harness' } }] } });
  await log(home, root, { records: [injected, message('u1', 'user', '真实用户需求', 2)] });
  await log(home, root, { id: BRANCH, source: { subagent: { other: 'guardian' } }, threadSource: 'guardian_review', records: [message('private', 'user', '内部工作记录', 1)] });
  await importData(project);
  const status = await memoryStatus(project);
  assert.equal(status.覆盖情况.已发现, 1);
  assert.equal(status.覆盖情况.待整理消息, 1);
  assert.equal(status.本地扫描.excludedInternalSessions, 1);
  assert.equal((await search(project, { query: '内部', includeHistory: true })).total, 0);
});
