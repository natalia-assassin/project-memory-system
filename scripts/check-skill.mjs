import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8');
const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
const name = front?.match(/^name:\s*(.+)$/m)?.[1];
const description = front?.match(/^description:\s*(.+)$/m)?.[1];
if (name !== 'project-memory-system' || !/^[a-z0-9-]{1,63}$/.test(name)) throw new Error('技能名称不符合规范。');
if (!description || description.length > 1024 || /[<>]/.test(description)) throw new Error('技能描述不符合规范。');
const links = [...text.matchAll(/\]\((references\/[^)]+)\)/g)].map(match => match[1]);
for (const link of links) await fs.access(path.join(root, link));
const metadata = await fs.readFile(path.join(root, 'agents', 'openai.yaml'), 'utf8');
if (!metadata.includes('$project-memory-system')) throw new Error('技能默认提示缺少调用标识。');
process.stdout.write('技能名称、描述、入口引用和界面元数据检查通过。\n');
