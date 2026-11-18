import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_ITEMS = ['SKILL.md', 'agents', 'scripts', 'references', 'tests', 'tools', 'README.md', 'package.json', '.gitignore', '.gitattributes'];
const source = fileURLToPath(new URL('../', import.meta.url));

export async function stageRelease(destination) {
  const target = path.resolve(destination);
  const tempRoot = path.join(source, '.tmp');
  if (!target.startsWith(tempRoot + path.sep) || target === tempRoot) throw new Error('发布预备目录必须位于本项目的 .tmp 子目录中。');
  await fs.mkdir(tempRoot, { recursive: true });
  // 目标必须是新目录，避免发布打包覆盖已有项目。
  await fs.mkdir(target);
  for (const item of RELEASE_ITEMS) {
    const origin = path.join(source, item);
    const stat = await fs.lstat(origin);
    if (stat.isSymbolicLink()) throw new Error(`发布源不能使用符号链接：${item}`);
    await fs.cp(origin, path.join(target, item), { recursive: true, errorOnExist: true, force: false });
  }
  return { 发布预备目录: target, 来源条目: RELEASE_ITEMS, 说明: '仅打包白名单源码；项目记忆、聊天、本机配置和临时工具均未包含。' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const destination = process.argv[2] ?? path.join(source, '.tmp', `release-${Date.now()}`);
    process.stdout.write(`${JSON.stringify(await stageRelease(destination), null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
