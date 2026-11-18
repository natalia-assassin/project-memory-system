import { loadProject, now, readState, saveState, withLock } from './storage.mjs';
import { importData } from './importers.mjs';
import { context } from './memory.mjs';

export const FOLLOWUP_MARKER = '[项目记忆系统补写]';
const keyFor = (session, turn) => `${session}:${turn}`;

export async function handleHook(root, event) {
  if (!event || typeof event.hook_event_name !== 'string') throw new Error('触发输入缺少 hook_event_name。');
  const project = await loadProject(root);
  const name = event.hook_event_name;
  const readonly = event.permission_mode === 'plan' || event.permission_mode === 'read-only' || process.env.PROJECT_MEMORY_READ_ONLY === '1';
  const session = event.session_id, turn = event.turn_id;
  if (['SessionStart', 'UserPromptSubmit'].includes(name)) {
    if (!readonly) {
      if (event.transcript_path) await importData(project, { onlySessionId: session, transcriptPath: event.transcript_path });
      await withLock(project, async () => {
        const state = await readState(project);
        state.hooks[name] = now();
        if (name === 'UserPromptSubmit' && session && turn) {
          const match = String(event.prompt ?? '').match(/^\[项目记忆系统补写\] 原任务标识：([^\s]+)\s/);
          if (match && state.followups[keyFor(session, match[1])]?.requestedAt) state.origins[keyFor(session, turn)] = match[1];
        }
        await saveState(project, state);
      });
    }
    const loaded = await context(project, { query: event.prompt ?? '' });
    const state = await readState(project);
    const originalTurn = state.origins[keyFor(session, turn)] ?? turn;
    const instructions = readonly
      ? '当前为只读或计划模式：仅参考记忆，不导入、不写入、不触发补写。'
      : `本轮保存凭据：sessionId=${session ?? ''}，turnId=${originalTurn ?? ''}。任务结束前按 $project-memory-system 保存有来源的变化；确无新增内容时使用 noChanges=true。存在待整理原文时分批整理并保存 processed 断点。`;
    return { hookSpecificOutput: { hookEventName: name, additionalContext: `${instructions}\n\n${loaded.text}` } };
  }
  if (readonly) return {};
  if (name === 'Stop' || name === 'SessionEnd') {
    if (event.transcript_path) await importData(project, { onlySessionId: session, transcriptPath: event.transcript_path });
    return withLock(project, async () => {
      const state = await readState(project);
      state.hooks[name] = now();
      if (name === 'SessionEnd' || !session || !turn) { await saveState(project, state); return {}; }
      const originalTurn = state.origins[keyFor(session, turn)] ?? turn;
      const key = keyFor(session, originalTurn);
      if (state.receipts[key]) {
        if (state.followups[key]) state.followups[key].resolvedAt = now();
        await saveState(project, state);
        return {};
      }
      const prior = state.followups[key];
      if (event.stop_hook_active === true || state.origins[keyFor(session, turn)] || prior?.requestedAt) {
        state.followups[key] = { ...prior, pendingAt: now(), reason: '自动补写尚未保存凭据，已停止继续补写。' };
        await saveState(project, state);
        return { systemMessage: '项目记忆尚未同步；自动补写已达到一次上限，下次任务开始时可继续整理。' };
      }
      state.followups[key] = { requestedAt: now(), reason: '任务结束时尚未保存记忆凭据。' };
      await saveState(project, state);
      return {
        decision: 'block',
        reason: `${FOLLOWUP_MARKER} 原任务标识：${originalTurn} 请仅补做一次记忆整理：读取 $project-memory-system，先 import 导入本轮可见原文，读取 context --pending，保存新增需求、决策、进度或待办及 processed 断点。写入凭据 sessionId=${session}、turnId=${originalTurn}；没有新增记忆时也用 record 保存 noChanges=true。保存失败则说明待同步状态，不反复重试。`
      };
    });
  }
  return {};
}
