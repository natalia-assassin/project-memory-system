# 命令与记忆写入接口

所有命令位于技能目录的 `scripts/project-memory.mjs`。`--project` 必须是已存在项目的绝对路径。正常输出为 JSON，操作提示为中文；错误输出至标准错误并返回非零退出状态。hook 专供客户端调用，接收标准输入 JSON 并且只输出合法触发 JSON，故障不会阻断用户任务。

## 操作

| 操作 | 参数与用途 |
| --- | --- |
| install | `--project`，可选 `--desktop-project`、`--codex-home`、重复 `--alias`、`--shared-with`、`--dry-run` |
| init | `npx skills add` 安装技能后初始化项目；与 install 使用同一套幂等接入逻辑与参数，不需要原始源码目录 |
| import | `--project`，可选 `--input`、`--codex-home`、`--no-local`；导入原文并建立待整理队列 |
| search | `--query`、`--kind memory/transcript/all`、`--thread`、`--include-history`、分页 `--offset`/`--limit` |
| search 原文 | `--thread`、`--host`、`--message-id`，按 Unicode 字符分页，默认每段 6,000 字符 |
| context | `--query`、`--max-chars`（默认 6,000）；`--pending` 获取待整理消息，可用 `--thread` 缩小范围 |
| record | `--input` 指向 JSON 文件，或 `--input -` 从标准输入读；原子保存记忆、摘要断点与任务凭据 |
| status | 覆盖数量、分页进度、待整理内容、冲突、未完成补写及触发配置状态 |

## 写入格式

```json
{
  "sessionId": "触发上下文提供的聊天标识",
  "turnId": "触发上下文提供的原任务标识",
  "records": [
    {
      "id": "decision-currency-v1",
      "type": "decision",
      "key": "billing.currency",
      "text": "项目结算统一使用人民币。",
      "status": "confirmed",
      "reason": "用户已明确确认。",
      "sources": [ { "threadId": "聊天标识", "hostId": "local", "messageId": "已归档用户消息标识" } ],
      "topics": ["结算"],
      "files": ["业务文件相对路径"],
      "supersedes": []
    }
  ],
  "processed": [ { "threadId": "聊天标识", "hostId": "local", "messageIds": ["已完整阅读并整理的消息标识"] } ]
}
```

- type：overview（概况）、requirement（需求）、decision（决策）、progress（进度）、todo（待办）、issue（问题）。
- status：confirmed（用户确认）、proposed（助手建议）、observed（已观察到）、open（未完成）、done（完成）、conflict（冲突）。confirmed 必须引用有效用户消息。
- sources 必须指向已归档且处于有效历史分支的消息；可引用工具结果作为执行证据。消息标识从 context 或 search 获取，不编造。
- id 可省略，脚本根据类型、主题和文本稳定生成。已有 id 不直接改写；用户明确改变决定时新增记录，用 supersedes 指向同类型、同 key 的旧记录。
- 同 key 下相互矛盾且优先级相同的结论保留并显示冲突；用户确认优先于助手建议。文字是否等义由 Codex 提炼时判断，脚本不会用关键词猜测语义。
- processed 记录原文指纹；后续原文补全时会重新进入待整理队列。长消息分段读取全部内容后再标记完成。
- sessionId 与 turnId 只在真实值可用时填写，必须成对提供。自动补写时使用触发上下文指定的原任务标识。

本轮无新增长期记忆时：

```json
{
  "sessionId": "真实聊天标识",
  "turnId": "真实任务标识",
  "records": [],
  "noChanges": true,
  "processed": []
}
```

仅有 noChanges 不会自动把待整理历史标为完成；已经阅读的消息仍需登记 processed。

## 存储与恢复

`.project-memory/config.json` 保存项目身份及登记路径；工作树的配置可指向主项目。`transcripts/*.jsonl` 保存每个聊天的原子归档，首行为聊天元信息，后续为带来源的规范化原文。`state.json` 保存记忆、提炼断点、清单遍历进度和任务凭据。

`overview.md` 与 `index.json` 为可重建视图，读取与检索以原文和 state.json 为准；视图滞后不代表原始数据丢失。`backups/` 保存接入时修改的已有项目文件。原始 Codex 会话文件始终只读。

写入使用短时项目锁与同步后原子替换。另一个活跃写入者持锁超过等待期限时返回尚未保存，后续可重试。仅自动回收本机已退出进程的锁，不按时间强行删除另一主机的锁；网络盘上无法证明失效的锁需先确认写入进程状态。

项目默认忽略整个记忆目录。普通脚本不会在后台运行模型；内容提炼由使用本技能的 Codex 完成。
