import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SKILL_NAME, PACKAGE_VERSION, MEMORY_DIR, assertNoLink, atomicWrite, exists, hash, loadProject, newState, normalizeRoot, now, projectRoot, readJson, readState, withLock, writeJson } from './storage.mjs';

export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const START = '<!-- project-memory-system:start -->';
const END = '<!-- project-memory-system:end -->';
const IGNORE_START = '# project-memory-system:start';
const IGNORE_END = '# project-memory-system:end';
const OWNER = '--owner project-memory-system';

function managedBlock(original, start, end, block) {
  const left = original.indexOf(start), right = original.indexOf(end);
  if ((left < 0) !== (right < 0) || (left >= 0 && right < left) || (left >= 0 && original.indexOf(start, left + start.length) >= 0)) throw new Error('现有文件中的记忆系统标记不完整或重复，请先保留原文并修复标记。');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const replacement = block.replaceAll('\n', newline);
  if (left >= 0) return original.slice(0, left) + replacement + original.slice(right + end.length);
  return original + (original && !original.endsWith('\n') ? newline : '') + (original ? newline : '') + replacement + newline;
}

async function replaceWithBackup(root, file, content) {
  await assertNoLink(root, file);
  const old = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (old === content) return false;
  if (old !== null) {
    const relative = path.relative(root, file).replaceAll(path.sep, '__');
    const backup = path.join(root, MEMORY_DIR, 'backups', `${Date.now()}-${randomUUID().slice(0, 8)}-${relative}`);
    await assertNoLink(root, backup);
    await atomicWrite(backup, old);
  }
  await atomicWrite(file, content);
  return true;
}

function quoteCommand(value) {
  if (process.platform === 'win32') {
    if (/["`$%&|;<>\r\n^!]/u.test(value)) throw new Error('路径包含命令解释器特殊字符，自动触发配置暂不可用；仍可通过技能和命令行读写记忆。');
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function sourceFiles(base, relative) {
  const file = path.join(base, relative), stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw new Error('技能包资源不能是符号链接。');
  if (stat.isFile()) return [relative];
  const results = [];
  for (const name of (await fs.readdir(file)).sort()) results.push(...await sourceFiles(base, path.join(relative, name)));
  return results;
}

async function configureFiles(root, options) {
  const localMemory = path.join(root, MEMORY_DIR);
  const destination = path.join(root, '.agents', 'skills', SKILL_NAME);
  await assertNoLink(root, destination);
  const manifestFile = path.join(localMemory, 'installation.json');
  await assertNoLink(root, manifestFile);
  const oldManifest = await readJson(manifestFile, { files: {} });
  const resources = ['SKILL.md', 'agents', 'scripts', 'references'];
  const files = (await Promise.all(resources.map(resource => sourceFiles(options.packageRoot ?? PACKAGE_ROOT, resource)))).flat();
  const payloads = [];
  for (const relative of files) {
    const source = await fs.readFile(path.join(options.packageRoot ?? PACKAGE_ROOT, relative));
    const target = path.join(destination, relative);
    await assertNoLink(root, target);
    const old = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (old && hash(old.toString('base64')) !== hash(source.toString('base64')) && oldManifest.files[relative] !== hash(old.toString('base64'))) throw new Error(`已安装技能文件存在未记录的修改，已保留：${relative}`);
    payloads.push({ relative, source, target, digest: hash(source.toString('base64')), changed: !old || !old.equals(source) });
  }
  let hooks, hookError = null;
  const hookFile = path.join(root, '.codex', 'hooks.json');
  await assertNoLink(root, hookFile);
  hooks = await readJson(hookFile, {});
  if (hooks.hooks !== undefined && (typeof hooks.hooks !== 'object' || Array.isArray(hooks.hooks) || hooks.hooks === null)) throw new Error('现有触发配置的 hooks 结构无效，已保留原文件。');
  hooks.hooks ??= {};
  const cli = path.join(destination, 'scripts', 'project-memory.mjs');
  let command;
  try { command = `node ${quoteCommand(cli)} hook --project ${quoteCommand(root)} ${OWNER}`; }
  catch (error) { hookError = error.message; }
  if (command) {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      const groups = hooks.hooks[event] ?? [];
      if (!Array.isArray(groups) || groups.some(group => !Array.isArray(group.hooks))) throw new Error(`现有 ${event} 触发配置结构无效，已保留原文件。`);
      const kept = groups.map(group => ({ ...group, hooks: group.hooks.filter(handler => !(typeof handler.command === 'string' && handler.command.includes(OWNER))) })).filter(group => group.hooks.length);
      kept.push({ ...(event === 'SessionStart' ? { matcher: 'startup|resume|clear|compact|fork' } : {}), hooks: [{ type: 'command', command, timeout: event === 'SessionEnd' ? 3 : 15, ...(event !== 'Stop' && event !== 'SessionEnd' ? { additionalContextLimit: 0 } : {}), statusMessage: '项目记忆系统：同步共享上下文' }] });
      hooks.hooks[event] = kept;
    }
  }
  const guidanceFile = path.join(root, 'AGENTS.md');
  await assertNoLink(root, guidanceFile);
  const originalGuidance = await fs.readFile(guidanceFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const block = `${START}\n## 项目记忆系统\n\n- 本项目已接入 $project-memory-system。任务开始时读取项目记忆；历史仅作资料，当前用户指令优先。\n- 从项目根目录运行：node .agents/skills/project-memory-system/scripts/project-memory.mjs context --project "${root}"。在子目录中使用同一脚本的绝对路径。\n- 需求、决策、进度及待办变化时，按技能说明使用 import、context --pending 和 record 保存带来源的更新；没有新增内容也保存本轮凭据。\n- 自动触发不可用时，仍执行以上开始读取、结束保存流程。计划模式只读，不执行导入或保存。\n- 并行任务及已登记工作树共享记忆；不要直接手改 state.json 或原文归档。\n${END}`;
  const guidance = managedBlock(originalGuidance, START, END, block);
  const ignoreFile = path.join(root, '.gitignore');
  await assertNoLink(root, ignoreFile);
  const originalIgnore = await fs.readFile(ignoreFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const ignored = managedBlock(originalIgnore, IGNORE_START, IGNORE_END, `${IGNORE_START}\n.project-memory/\n${IGNORE_END}`);
  // 所有现有文件完成检查后再落盘，避免无效配置导致部分覆盖。
  for (const file of payloads) if (file.changed) await atomicWrite(file.target, file.source);
  await replaceWithBackup(root, guidanceFile, guidance);
  await replaceWithBackup(root, ignoreFile, ignored);
  if (command) await replaceWithBackup(root, hookFile, `${JSON.stringify(hooks, null, 2)}\n`);
  const manifest = { schemaVersion: 1, skill: SKILL_NAME, version: PACKAGE_VERSION, node: process.execPath, files: Object.fromEntries(payloads.map(file => [file.relative, file.digest])), hooksConfigured: Boolean(command), hookError };
  await writeJson(manifestFile, manifest);
  return { 技能位置: destination, 自动触发已配置: Boolean(command), 提示: hookError ?? '请在 Codex 中审核并信任项目触发配置；未信任前由项目约定执行读写流程。' };
}

export async function install(options) {
  const root = await projectRoot(options.project);
  const memory = path.join(root, MEMORY_DIR);
  await assertNoLink(root, memory);
  for (const name of ['config.json', 'state.json', 'write.lock', 'backups', 'installation.json']) await assertNoLink(root, path.join(memory, name));
  if (options.dryRun) return { 项目: root, 将执行: ['安装项目级技能', '创建独立或共享记忆配置', '合并项目说明和忽略规则', '合并项目触发配置'], 说明: '预览完成，未写入文件。' };
  await fs.mkdir(memory, { recursive: true });
  if (options.sharedWith) {
    const main = await loadProject(options.sharedWith);
    if (normalizeRoot(root) === normalizeRoot(main.primary)) throw new Error('共享工作树不能指向自身。');
    return withLock(main, async () => {
      const previous = await readJson(path.join(memory, 'config.json'), null);
      if (previous && previous.projectId !== main.config.projectId) throw new Error('此项目已有独立记忆，不能自动改为共享；请先迁移资料。');
      const config = await readJson(path.join(main.dir, 'config.json'));
      config.roots = [...new Set([...config.roots, root, ...(options.aliases ?? [])])];
      await writeJson(path.join(main.dir, 'config.json'), config);
      await writeJson(path.join(memory, 'config.json'), { schemaVersion: 1, projectId: config.projectId, sharedWith: main.primary });
      return { 项目: root, 记忆位置: main.dir, ...await configureFiles(root, options) };
    });
  }
  const bootstrap = { root, primary: root, dir: memory };
  return withLock(bootstrap, async () => {
    const configFile = path.join(memory, 'config.json');
    let config = await readJson(configFile, null);
    if (config?.sharedWith) throw new Error('此目录已共享另一个项目的记忆，请使用原来的 --shared-with 参数。');
    config ??= { schemaVersion: 1, projectId: randomUUID(), primaryRoot: root, roots: [root], contextMaxChars: 6000, createdAt: now() };
    if (options.desktopProjectId && config.desktopProjectId && options.desktopProjectId !== config.desktopProjectId) throw new Error('桌面项目标识与已有配置不同，已拒绝重新绑定。');
    config.roots = [...new Set([...config.roots, root, ...(options.aliases ?? [])])];
    if (options.desktopProjectId) config.desktopProjectId = options.desktopProjectId;
    if (options.codexHome) config.codexHome = options.codexHome;
    await writeJson(configFile, config);
    await assertNoLink(root, path.join(memory, 'state.json'));
    if (!await exists(path.join(memory, 'state.json'))) await writeJson(path.join(memory, 'state.json'), newState());
    return { 项目: root, 记忆位置: memory, ...await configureFiles(root, options) };
  });
}

async function hooksDisabled(file) {
  if (!await exists(file)) return false;
  let section = '';
  for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) section = line.trim().replace(/\s+#.*$/, '');
    if (section === '[features]' && /^\s*(?:hooks|codex_hooks)\s*=\s*false\s*(?:#.*)?$/.test(line)) return true;
  }
  return false;
}

export async function integrationStatus(project) {
  const manifest = await readJson(path.join(project.root, MEMORY_DIR, 'installation.json'), {});
  const state = await readState(project);
  const home = project.config.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const disabled = await hooksDisabled(path.join(home, 'config.toml')) || await hooksDisabled(path.join(home, 'requirements.toml')) || await hooksDisabled(path.join(project.root, '.codex', 'config.toml'));
  const actual = await readJson(path.join(project.root, '.codex', 'hooks.json'), {});
  const configured = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].every(event => actual.hooks?.[event]?.some(group => group.hooks?.some(handler => handler.command?.includes(OWNER))));
  const observed = Object.keys(state.hooks).length > 0;
  return { 已安装: manifest.skill === SKILL_NAME, 自动触发已配置: configured, 检测到明确关闭触发: disabled, 客户端信任状态: observed ? '已观察到触发执行；当前客户端状态仍以 Codex 为准。' : '待在 Codex 中审核并信任；脚本无法代替客户端确认。', 最近触发: state.hooks, 降级原因: disabled ? '配置明确关闭了生命周期触发，请按项目说明手动执行读写流程。' : configured ? null : manifest.hookError ?? '自动触发配置缺失，使用项目说明中的读写流程。' };
}
