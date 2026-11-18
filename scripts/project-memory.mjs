#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from './lib/storage.mjs';
import { install, integrationStatus } from './lib/integration.mjs';
import { importData } from './lib/importers.mjs';
import { context, memoryStatus, recordMemory, search } from './lib/memory.mjs';
import { handleHook } from './lib/hooks.mjs';

const HELP = `项目记忆系统（需要 Node.js 22 或更新版本）

接入：  node scripts/project-memory.mjs install --project "项目绝对路径" [--desktop-project "桌面项目标识"]
初始化：node .agents/skills/project-memory-system/scripts/project-memory.mjs init --project "项目绝对路径"
导入：  node scripts/project-memory.mjs import --project "项目绝对路径" [--codex-home "Codex目录"] [--input "桌面导出JSON文件"]
检索：  node scripts/project-memory.mjs search --project "项目绝对路径" --query "关键词"
上下文：node scripts/project-memory.mjs context --project "项目绝对路径" [--pending] [--thread "聊天标识"]
写入：  node scripts/project-memory.mjs record --project "项目绝对路径" --input "记忆JSON文件"
状态：  node scripts/project-memory.mjs status --project "项目绝对路径"

record 也支持 --input - 从标准输入读取 JSON。init 与 install 支持 --dry-run 预览、重复 --alias 登记历史路径，
以及 --shared-with "主项目绝对路径" 接入共享记忆的工作树。
原文分段：search --thread "聊天标识" --message-id "消息标识" --offset 0 --limit 6000。
计划/只读模式请设置 PROJECT_MEMORY_READ_ONLY=1；此时所有写入操作被拒绝。
详细说明见 README.md 和 references/。`;

const VALUE_OPTIONS = new Set(['project', 'desktop-project', 'codex-home', 'input', 'query', 'thread', 'host', 'message-id', 'offset', 'limit', 'max-chars', 'kind', 'alias', 'shared-with', 'owner']);
const FLAGS = new Set(['dry-run', 'pending', 'include-history', 'no-local', 'help']);

function parse(argv) {
  const command = argv[0] ?? 'help', values = {};
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || (!VALUE_OPTIONS.has(key) && !FLAGS.has(key))) throw new Error(`无法识别参数：${argv[i]}`);
    if (FLAGS.has(key)) { values[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值。`);
    if (key === 'alias') (values[key] ??= []).push(value); else values[key] = value;
  }
  for (const key of ['offset', 'limit', 'max-chars']) if (values[key] !== undefined) {
    const number = Number(values[key]);
    if (!Number.isSafeInteger(number) || number < (key === 'offset' ? 0 : 1)) throw new Error(`参数 --${key} 必须是有效整数。`);
    values[key] = number;
  }
  return { command, values };
}

async function readInput(value) {
  if (!value) throw new Error('请用 --input 指定 JSON 文件，或用 --input - 从标准输入读取。');
  let text;
  if (value === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString('utf8');
  } else text = await fs.readFile(value, 'utf8');
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('输入不是有效 JSON，请检查文件或标准输入。'); }
}

export async function run(argv) {
  const { command, values: v } = parse(argv);
  if (command === 'help' || command === '--help' || v.help) return { 使用说明: HELP };
  const readonly = process.env.PROJECT_MEMORY_READ_ONLY === '1' || process.env.CODEX_PERMISSION_MODE === 'plan';
  if (readonly && ['install', 'init', 'import', 'record'].includes(command) && !(['install', 'init'].includes(command) && v['dry-run'])) throw new Error('当前为只读或计划模式，不能接入、导入或写入记忆。');
  if (command === 'hook') {
    const event = await readInput('-');
    if (readonly) event.permission_mode = 'plan';
    return handleHook(v.project, event);
  }
  if (command === 'install' || command === 'init') return install({ project: v.project, desktopProjectId: v['desktop-project'], codexHome: v['codex-home'], aliases: v.alias, sharedWith: v['shared-with'], dryRun: v['dry-run'] });
  if (!['import', 'search', 'context', 'record', 'status'].includes(command)) throw new Error(`不支持的操作：${command}。请运行 help 查看用法。`);
  const project = await loadProject(v.project);
  if (command === 'import') return importData(project, { codexHome: v['codex-home'], local: !v['no-local'], input: v.input ? await readInput(v.input) : undefined });
  if (command === 'record') return recordMemory(project, await readInput(v.input));
  const options = { query: v.query, threadId: v.thread, hostId: v.host, messageId: v['message-id'], offset: v.offset, limit: v.limit, maxChars: v['max-chars'], kind: v.kind, includeHistory: v['include-history'], pending: v.pending };
  if (v.kind && !['memory', 'transcript', 'all'].includes(v.kind)) throw new Error('--kind 仅支持 memory、transcript 或 all。');
  if (command === 'context') return context(project, options);
  if (command === 'search') return search(project, options);
  return { ...await memoryStatus(project), 接入状态: await integrationStatus(project) };
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  try { process.stdout.write(`${JSON.stringify(await run(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) {
    if (process.argv[2] === 'hook') {
      // 触发故障不能阻断用户任务，也不能返回无效的纯文本。
      process.stdout.write(`${JSON.stringify({ systemMessage: `项目记忆暂未同步：${error.message}` })}\n`);
    } else {
      process.stderr.write(`${JSON.stringify({ 错误: error.message })}\n`);
      process.exitCode = 1;
    }
  }
}
