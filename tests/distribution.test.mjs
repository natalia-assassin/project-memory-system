import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { stageRelease } from '../tools/stage-release.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

function command(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script, ...args], { windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => { stdout += data; });
    proc.stderr.on('data', data => { stderr += data; });
    proc.on('error', reject);
    proc.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('技能由通用安装器放置后，可从安装副本初始化项目且不改动技能文件及安装锁', async t => {
  const { root, home } = await fixture(t, { noInstall: true });
  const skill = path.join(root, '.agents', 'skills', 'project-memory-system');
  await fs.mkdir(skill, { recursive: true });
  for (const item of ['SKILL.md', 'agents', 'scripts', 'references']) await fs.cp(path.join(sourceRoot, item), path.join(skill, item), { recursive: true });
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# 原项目约定\n保留此约定。\n');
  const lock = '{"version":2,"skills":{"project-memory-system":{"source":"example/project-memory-system"}}}\n';
  await fs.writeFile(path.join(root, 'skills-lock.json'), lock);
  const metadata = '{"installation":"external-installer"}\n';
  await fs.writeFile(path.join(skill, 'metadata.json'), metadata);
  const script = path.join(skill, 'scripts', 'project-memory.mjs');
  const original = await fs.readFile(script, 'utf8');
  const first = await command(script, ['init', '--project', root, '--codex-home', home]);
  assert.equal(first.code, 0, first.stderr);
  const config = JSON.parse(await fs.readFile(path.join(root, '.project-memory', 'config.json'), 'utf8'));
  assert.ok(config.projectId);
  const second = await command(script, ['init', '--project', root]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.project-memory', 'config.json'), 'utf8')).projectId, config.projectId);
  assert.equal(await fs.readFile(script, 'utf8'), original);
  assert.equal(await fs.readFile(path.join(root, 'skills-lock.json'), 'utf8'), lock);
  assert.equal(await fs.readFile(path.join(skill, 'metadata.json'), 'utf8'), metadata);
  assert.match(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /保留此约定/);
  const hooks = JSON.parse(await fs.readFile(path.join(root, '.codex', 'hooks.json'), 'utf8'));
  for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const handler of group.hooks) {
    assert.ok(handler.command.includes(script));
    assert.equal(handler.command.includes(path.join(sourceRoot, 'scripts', 'project-memory.mjs')), false);
  }
});

test('初始化命令遵守计划只读模式，预览不会创建项目记忆', async t => {
  const { root } = await fixture(t, { noInstall: true });
  const script = path.join(sourceRoot, 'scripts', 'project-memory.mjs');
  const denied = await command(script, ['init', '--project', root], { PROJECT_MEMORY_READ_ONLY: '1' });
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /只读/);
  const preview = await command(script, ['init', '--project', root, '--dry-run'], { PROJECT_MEMORY_READ_ONLY: '1' });
  assert.equal(preview.code, 0, preview.stderr);
  await assert.rejects(fs.access(path.join(root, '.project-memory')));
});

test('发布包仅含分发源码，排除聊天、运行时配置、临时文件及重复安装副本', async t => {
  const { temp } = await fixture(t, { noInstall: true });
  const target = path.join(temp, 'release');
  await stageRelease(target);
  for (const excluded of ['.project-memory', '.agents', '.codex', '.tmp', 'AGENTS.md', 'node_modules', '.git']) await assert.rejects(fs.access(path.join(target, excluded)));
  await fs.access(path.join(target, 'SKILL.md'));
  await fs.access(path.join(target, 'scripts', 'project-memory.mjs'));
  await fs.access(path.join(target, 'references', 'importing.md'));
  const validated = await command(path.join(target, 'scripts', 'check-skill.mjs'), []);
  assert.equal(validated.code, 0, validated.stderr);
  await assert.rejects(stageRelease(target), /EEXIST/);
  await assert.rejects(stageRelease(sourceRoot), /\.tmp/);
});
