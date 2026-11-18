# 项目记忆系统

让同一项目中的多个 Codex 聊天共享可追溯的需求、决策、进度和待办。支持 Codex 桌面版与命令行，每个项目独立安装。运行时只使用 Node.js 标准库、JSON、JSONL 和 Markdown，不需要外部数据库、向量服务或额外模型接口。

## 快速开始

需要 Node.js 22.20 或更新版本。先打开新项目或现有项目的根目录，在终端执行：

```shell
npx skills add https://github.com/natalia-assassin/project-memory-system --skill project-memory-system --agent codex
```

技能安装到当前项目的 `.agents/skills/project-memory-system/`。然后在该项目的 Codex 普通执行模式聊天中发送：

> 使用 $project-memory-system，初始化当前项目的独立记忆；如果已有历史聊天，请导入全部可访问的活动和归档聊天，并建立共享记忆。

Codex 会从已安装的技能目录运行初始化入口，建立记忆目录、合并项目说明和自动触发配置，并检查状态。初始化不依赖作者电脑上的源码路径。技能暂未出现在选择器时，重新打开项目聊天或重启 Codex。

`skills add` 安装的是技能文件；项目初始化由 Codex 按技能说明完成。此仓库通过 GitHub 分发，不需要发布或安装一个同名 npm 包。

## 启用自动读取与保存

初始化后，在 Codex 的 **设置 → Hooks** 或输入框附近的 **Review hooks** 中，审核并信任来自本项目 `.codex/hooks.json` 的四项定义：

| 事件 | 行为 |
| --- | --- |
| SessionStart | 启动、恢复或压缩上下文后加载记忆 |
| UserPromptSubmit | 每次提交消息时加载最新相关记忆 |
| Stop | 补归档并检查保存凭据；遗漏时最多补做一次整理 |
| SessionEnd | 会话结束时补归档 |

信任由客户端保存，不由技能代为授予。修改触发定义后可能需要重新审核。计划模式只读取，不导入、不写入或补写。自动触发不可用时，项目说明仍会指导 Codex 在任务开始和结束时维护记忆。机制见 [Codex 官方说明](https://learn.chatgpt.com/docs/hooks)。

检查当前项目状态：

```powershell
node .agents/skills/project-memory-system/scripts/project-memory.mjs status --project "你的项目绝对路径"
```

“自动触发已配置”只说明文件已存在。请结合真实聊天后出现的“最近触发”时间、保存凭据和跨聊天检索结果确认自动读写生效。

## 历史导入与日常使用

有桌面聊天工具时，由 Codex 分页遍历项目的活动及归档清单、逐页读取，再结合本地原文补全。没有桌面工具时，导入本地可访问的 Codex 会话记录或导出文件，并报告覆盖缺口。

原文归档、提炼记忆和待整理队列分别维护。脚本负责搬运、索引、来源校验和并发保存；内容提炼由当前 Codex 完成。单独执行 import 不会自动生成语义摘要。删除、无权访问或缺失的记录会如实报告。

你可以直接向 Codex 提问：

- “读取项目记忆，告诉我当前已确认的需求和未完成事项。”
- “这个决定是在哪个聊天确认的？请给出原文来源。”
- “任务已完成，请更新项目进度和下一步待办。”

需要手动检查时：

```powershell
node .agents/skills/project-memory-system/scripts/project-memory.mjs import --project "你的项目绝对路径"
node .agents/skills/project-memory-system/scripts/project-memory.mjs context --project "你的项目绝对路径" --pending
node .agents/skills/project-memory-system/scripts/project-memory.mjs search --project "你的项目绝对路径" --query "登录方案"
```

历史分支、桌面导出格式、旧路径及工作树共享见 [历史导入说明](references/importing.md)。结构化记忆写入与冲突规则见 [写入接口](references/record-format.md)。完整执行流程见 [SKILL.md](SKILL.md)。

## 项目内文件

| 位置 | 用途 |
| --- | --- |
| `.agents/skills/project-memory-system/` | 可复用技能与脚本 |
| `.project-memory/` | 本项目的原文、记忆、索引和进度，默认忽略 Git 提交 |
| `AGENTS.md` | 项目开始读取、结束保存的约定，仅合并受管区块 |
| `.codex/hooks.json` | 项目触发配置，保留其他已有定义 |

源仓库仅发布技能源码、说明与测试；不会包含作者的项目聊天、记忆、本机接入配置、凭据或临时工具。

## 从源码接入与开发验证

从本仓库源码接入一个项目，也可以执行：

```powershell
node scripts/project-memory.mjs install --project "你的项目绝对路径"
```

通用安装器安装后，Codex 使用的初始化入口为：

```powershell
node .agents/skills/project-memory-system/scripts/project-memory.mjs init --project "你的项目绝对路径"
```

两种入口使用相同的幂等逻辑，重复接入保留原有记忆和项目约定。开发验证：

```shell
npm test
npm run check
```

测试使用隔离项目，覆盖通用安装后的初始化、安装锁保留、历史分支、去重、来源追溯、并发保存、项目隔离、工作树共享、补写上限和计划模式只读。发布打包使用显式白名单，可通过 `npm run release:stage` 检查待分发内容。
