import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, ID, log, message } from './helpers.mjs';
import { install, integrationStatus } from '../scripts/lib/integration.mjs';
import { importData } from '../scripts/lib/importers.mjs';
import { context, recordMemory } from '../scripts/lib/memory.mjs';
import { exists, loadProject, readJson, readState } from '../scripts/lib/storage.mjs';
import { handleHook } from '../scripts/lib/hooks.mjs';
import { spawn } from 'node:child_process';

test('接入保留已有说明及触发配置，重复安装不重复追加，备份可追溯', async t => {
  const original = '# 现有项目说明\r\n保留原来的开发规范。\r\n';
  const { root, project } = await fixture(t, { beforeInstall: async root => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), original);
    await fs.writeFile(path.join(root, '.gitignore'), 'vendor/\n');
    await fs.mkdir(path.join(root, '.codex'));
    await fs.writeFile(path.join(root, '.codex', 'hooks.json'), JSON.stringify({ description: '已有描述', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node existing-hook.mjs' }] }] } }));
  } });
  const first = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  await install({ project: root });
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), first);
  assert.ok(first.startsWith(original));
  const hooks = await readJson(path.join(root, '.codex', 'hooks.json'));
  assert.equal(hooks.description, '已有描述');
  assert.equal(hooks.hooks.Stop.length, 2);
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'node existing-hook.mjs');
  assert.ok(hooks.hooks.SessionEnd.every(group => group.hooks.every(handler => handler.timeout >= 1 && handler.timeout <= 3)), 'Codex 的结束触发超时必须在 1 至 3 秒内。');
  assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /vendor\/[\s\S]*\.project-memory\//);
  assert.ok((await fs.readdir(path.join(project.dir, 'backups'))).length >= 3);
  assert.equal((await integrationStatus(project)).自动触发已配置, true);
});

test('安装预览不写文件，无 Git 项目可接入，拒绝相对路径', async t => {
  const { root } = await fixture(t, { noInstall: true });
  await install({ project: root, dryRun: true });
  assert.equal(await exists(path.join(root, '.project-memory')), false);
  await assert.rejects(install({ project: '.' }), /绝对路径/);
  await install({ project: root });
  assert.equal(await exists(path.join(root, '.git')), false);
  assert.equal(await exists(path.join(root, '.agents', 'skills', 'project-memory-system', 'SKILL.md')), true);
});

test('已有损坏触发配置不被覆盖', async t => {
  const { root } = await fixture(t, { noInstall: true });
  await fs.mkdir(path.join(root, '.codex'));
  const file = path.join(root, '.codex', 'hooks.json');
  await fs.writeFile(file, '{broken');
  await assert.rejects(install({ project: root }), /JSON 文件损坏/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  assert.equal(await exists(path.join(root, 'AGENTS.md')), false);
});

test('已登记工作树拥有技能并共享主项目记忆', async t => {
  const { temp, root, home, project } = await fixture(t);
  const worktree = path.join(temp, '独立工作树'); await fs.mkdir(worktree);
  await install({ project: worktree, sharedWith: root });
  const linked = await loadProject(worktree);
  assert.equal(linked.dir, project.dir);
  await log(home, worktree, { records: [message('u1', 'user', '工作树确认需求', 1)] });
  const refreshed = await loadProject(root);
  await importData(refreshed);
  await recordMemory(linked, { records: [{ type: 'requirement', key: 'worktree.requirement', text: '工作树确认需求', status: 'confirmed', sources: [{ threadId: ID, messageId: 'u1' }] }] });
  assert.match((await context(refreshed)).text, /工作树确认需求/);
  assert.ok(await exists(path.join(worktree, '.agents', 'skills', 'project-memory-system', 'SKILL.md')));
});

test('修改过的已安装技能不会被静默覆盖', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, '.agents', 'skills', 'project-memory-system', 'SKILL.md');
  await fs.appendFile(file, '\n本项目定制内容\n');
  await assert.rejects(install({ project: root }), /未记录的修改/);
  assert.match(await fs.readFile(file, 'utf8'), /本项目定制内容/);
});

test('计划模式触发仅读取，不更改记忆、导入日志或请求补写', async t => {
  const { root, home, project } = await fixture(t);
  const file = await log(home, root, { records: [message('u1', 'user', '尚未导入的消息', 1)] });
  const before = await fs.readFile(path.join(project.dir, 'state.json'), 'utf8');
  const loaded = await handleHook(root, { hook_event_name: 'SessionStart', session_id: ID, permission_mode: 'plan', transcript_path: file });
  assert.match(loaded.hookSpecificOutput.additionalContext, /只读/);
  assert.deepEqual(await handleHook(root, { hook_event_name: 'Stop', session_id: ID, turn_id: 'turn-p', permission_mode: 'plan', transcript_path: file }), {});
  assert.equal(await fs.readFile(path.join(project.dir, 'state.json'), 'utf8'), before);
  assert.equal(await exists(path.join(project.dir, 'transcripts')), false);
});

test('自动补写最多一次，正常凭据不触发续写，并可在后续任务消除待同步', async t => {
  const { root, project } = await fixture(t);
  const event = { hook_event_name: 'Stop', session_id: ID, turn_id: 'original', permission_mode: 'default' };
  const first = await handleHook(root, event);
  assert.equal(first.decision, 'block');
  const repeated = await handleHook(root, event);
  assert.equal(repeated.decision, undefined);
  assert.match(repeated.systemMessage, /上限/);
  await handleHook(root, { hook_event_name: 'UserPromptSubmit', session_id: ID, turn_id: 'continuation', prompt: first.reason, permission_mode: 'default' });
  const next = await handleHook(root, { ...event, turn_id: 'continuation', stop_hook_active: true });
  assert.equal(next.decision, undefined);
  await recordMemory(project, { sessionId: ID, turnId: 'original', noChanges: true });
  assert.deepEqual(await handleHook(root, event), {});
  assert.ok((await readState(project)).followups[`${ID}:original`].resolvedAt);
});

test('新消息与压缩恢复触发加载最新记忆，明确关闭触发会显示降级', async t => {
  const { root, home, project } = await fixture(t);
  await log(home, root, { records: [message('u1', 'user', '新确认约束', 1)] });
  await importData(project);
  await recordMemory(project, { records: [{ type: 'requirement', key: 'new', text: '新确认约束', status: 'confirmed', sources: [{ threadId: ID, messageId: 'u1' }] }] });
  for (const event of [{ hook_event_name: 'UserPromptSubmit', turn_id: 'fresh', prompt: '约束' }, { hook_event_name: 'SessionStart', source: 'compact' }]) {
    const loaded = await handleHook(root, { ...event, session_id: ID, permission_mode: 'default' });
    assert.match(loaded.hookSpecificOutput.additionalContext, /新确认约束/);
  }
  await fs.writeFile(path.join(home, 'config.toml'), '[features]\nhooks = false\n');
  assert.equal((await integrationStatus(project)).检测到明确关闭触发, true);
});

test('安装后的副本可由真实命令解释器执行自动触发，路径包含中文和空格', async t => {
  const { root } = await fixture(t);
  const hooks = await readJson(path.join(root, '.codex', 'hooks.json'));
  const command = hooks.hooks.SessionStart.at(-1).hooks[0].command;
  const event = { hook_event_name: 'SessionStart', session_id: ID, permission_mode: 'plan' };
  const result = await new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
    const proc = spawn(shell, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => { stdout += data; }); proc.stderr.on('data', data => { stderr += data; });
    proc.on('error', reject); proc.on('close', code => resolve({ code, stdout, stderr }));
    proc.stdin.end(JSON.stringify(event));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /只读/);
});

test('目录联接不能把接入写入引向项目外', async t => {
  const { root, temp } = await fixture(t, { noInstall: true });
  const outside = path.join(temp, '外部目录'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, '.project-memory'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(install({ project: root }), /链接|联接/);
  assert.deepEqual(await fs.readdir(outside), []);
});
