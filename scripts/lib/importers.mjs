import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { assertNoLink, belongsToProject, exists, hash, messageHash, now, readJson, readThreads, readState, saveState, threadKey, unwrap, walkJsonl, withLock, writeThread } from './storage.mjs';

const knownInvisible = new Set(['reasoning', 'additional_tools', 'compaction']);
const supportedResponses = new Set(['message', 'function_call', 'custom_tool_call', 'tool_call', 'function_call_output', 'custom_tool_call_output', 'tool_result', 'web_search_call']);
const plain = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const reference = (file, line, ordinal) => ({ source: 'codex-local', file, line, ordinal });
const internalSession = meta => Boolean(meta.source?.subagent) || meta.source === 'subagent' || ['guardian_review', 'memory_generation', 'memory_consolidation', 'title_generation'].includes(meta.thread_source);

function publicContent(payload) {
  if (payload.role !== 'user' || !Array.isArray(payload.content)) return payload.content;
  const metadata = payload.internal_chat_message_metadata_passthrough;
  return payload.content.filter((_, index) => metadata?.content_item_metadata?.[index]?.provenance?.type !== 'harness' && !metadata?.content_item_kinds?.[index]?.startsWith('environments.'));
}

function contentParts(content) {
  const texts = [], attachments = [];
  if (typeof content === 'string') return { text: content, attachments };
  for (const item of content ?? []) {
    if (typeof item?.text === 'string' && ['input_text', 'output_text', 'text'].includes(item.type)) texts.push(item.text);
    else if (/image|audio|file|video/.test(item?.type ?? '')) {
      const value = item.image_url?.url ?? item.image_url ?? item.url ?? item.file_id ?? item.path ?? item.filename;
      attachments.push({ type: item.type, reference: typeof value === 'string' && !value.startsWith('data:') ? value : '来源中内嵌的媒体；此处仅保存引用', name: item.filename });
    }
  }
  return { text: texts.join('\n'), attachments };
}

function fromResponse(record, file, line) {
  const p = record.payload;
  if (!p || knownInvisible.has(p.type)) return null;
  const base = { at: record.timestamp ?? null, ordinal: record.ordinal ?? line, turnId: p.internal_chat_message_metadata_passthrough?.turn_id, sources: [reference(file, line, record.ordinal)], truncated: false };
  if (p.type === 'message') {
    if (!['user', 'assistant'].includes(p.role) || p.phase === 'analysis') return null;
    const visible = publicContent(p);
    if (Array.isArray(visible) && !visible.length) return null;
    const content = contentParts(visible);
    return { ...base, id: p.id ?? `local-${hash([file, record.ordinal ?? line, p]).slice(0, 32)}`, kind: 'message', role: p.role, phase: p.phase ?? null, ...content };
  }
  if (['function_call', 'custom_tool_call', 'tool_call'].includes(p.type)) {
    return { ...base, id: `call-${p.call_id ?? p.id ?? hash([file, line, p])}`, kind: 'tool', role: 'tool', name: p.name ?? '工具调用', text: plain(p.arguments ?? p.input), attachments: [] };
  }
  if (['function_call_output', 'custom_tool_call_output', 'tool_result'].includes(p.type)) {
    return { ...base, id: `result-${p.call_id ?? p.id ?? hash([file, line, p])}`, kind: 'tool', role: 'tool', name: '工具结果', text: plain(p.output ?? p.content), attachments: [] };
  }
  if (p.type === 'web_search_call') return { ...base, id: p.id ?? `web-${hash([file, line, p])}`, kind: 'tool', role: 'tool', name: '网页搜索', text: JSON.stringify({ action: p.action, status: p.status, results: p.results }), attachments: [] };
  return null;
}

function fromEvent(record, file, line) {
  const p = record.payload;
  if (!['user_message', 'agent_message'].includes(p?.type)) return null;
  return {
    id: p.id ?? `event-${hash([file, record.ordinal ?? line, p]).slice(0, 32)}`,
    kind: 'message', role: p.type === 'user_message' ? 'user' : 'assistant', text: p.message ?? '',
    at: record.timestamp ?? null, ordinal: record.ordinal ?? line, attachments: [], truncated: false,
    sources: [reference(file, line, record.ordinal)]
  };
}

async function firstRecord(file) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) { return JSON.parse(line.replace(/^\uFEFF/, '')); }
  } finally { reader.close(); stream.destroy(); }
  return null;
}

async function parseSegment(file, header) {
  const bytes = await fs.readFile(file);
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  const records = [], warnings = [];
  let offset = hasBom ? 3 : 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { offset += Buffer.byteLength(line) + 1; continue; }
    try { records.push({ value: JSON.parse(line), file, line: i + 1, byteEnd: offset + Buffer.byteLength(line) + 1 }); }
    catch {
      warnings.push(i === lines.length - 1 && !text.endsWith('\n') ? `文件末行尚未写完：${path.basename(file)}` : `文件第 ${i + 1} 行无法解析：${path.basename(file)}`);
    }
    offset += Buffer.byteLength(line) + 1;
  }
  const name = path.basename(file, '.jsonl');
  const ids = name.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi);
  return { file, header, segmentId: ids?.at(-1) ?? header.payload.id, records, warnings, timestamp: header.payload.timestamp ?? header.timestamp ?? (await fs.stat(file)).mtime.toISOString(), bytes: bytes.length };
}

export async function discoverLocal(project, options = {}) {
  const home = options.codexHome ?? project.config.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const files = [...await walkJsonl(path.join(home, 'sessions')), ...await walkJsonl(path.join(home, 'archived_sessions'))];
  if (options.transcriptPath && !files.includes(options.transcriptPath) && await exists(options.transcriptPath)) files.push(options.transcriptPath);
  const groups = new Map(), warnings = [], excludedThreadIds = [];
  for (const file of files) {
    let header;
    try { header = await firstRecord(file); }
    catch (error) { warnings.push(`无法检查会话文件：${path.basename(file)}（${error.message}）`); continue; }
    const meta = header?.payload;
    if (header?.type !== 'session_meta' || typeof meta?.id !== 'string') { warnings.push(`未识别的会话格式：${path.basename(file)}`); continue; }
    if (options.onlySessionId && meta.id !== options.onlySessionId) continue;
    if (!await belongsToProject(project, meta.cwd)) continue;
    if (internalSession(meta)) { excludedThreadIds.push(meta.id); continue; }
    const group = groups.get(meta.id) ?? [];
    group.push(await parseSegment(file, header));
    groups.set(meta.id, group);
  }
  const threads = [];
  for (const [id, segments] of groups) {
    const ordered = segments.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.file.localeCompare(b.file));
    const byId = new Map(segments.map(segment => [segment.segmentId, segment]));
    const issues = [...segments.flatMap(segment => segment.warnings)];
    const referenced = new Set(segments.map(segment => segment.header.payload.history_base?.thread_id).filter(Boolean));
    const heads = ordered.filter(segment => !referenced.has(segment.segmentId));
    const head = (heads.length ? heads : ordered).at(-1);
    function effective(segment, seen = new Set()) {
      if (seen.has(segment.segmentId)) { issues.push('历史引用存在循环，无法证明原文完整。'); return []; }
      const nextSeen = new Set([...seen, segment.segmentId]);
      const base = segment.header.payload.history_base;
      if (!base) return segment.records;
      const parent = byId.get(base.thread_id);
      if (!parent) { issues.push(`缺少历史基底：${base.thread_id}`); return segment.records; }
      const inherited = effective(parent, nextSeen).filter(record => {
        if (Number.isFinite(base.end_ordinal_exclusive) && Number.isFinite(record.value.ordinal)) return record.value.ordinal < base.end_ordinal_exclusive;
        if (Number.isFinite(base.end_byte_offset)) return record.byteEnd <= base.end_byte_offset;
        issues.push('历史引用缺少可验证的边界。'); return false;
      });
      return [...inherited, ...segment.records];
    }
    const activeRecords = effective(head);
    const allRecords = segments.flatMap(segment => segment.records);
    const excludedMessageIds = allRecords.filter(({ value }) => value.type === 'response_item' && value.payload?.type === 'message' && value.payload.role === 'user' && Array.isArray(publicContent(value.payload)) && publicContent(value.payload).length === 0).map(({ value }) => value.payload.id).filter(Boolean);
    for (const { value } of activeRecords) if (value.type === 'response_item' && !knownInvisible.has(value.payload?.type) && !supportedResponses.has(value.payload?.type)) issues.push(`未识别的可见记录类型：${value.payload?.type ?? '缺失类型'}`);
    const hasResponses = allRecords.some(({ value }) => value.type === 'response_item' && value.payload?.type === 'message' && ['user', 'assistant'].includes(value.payload.role));
    const convert = record => record.value.type === 'response_item' ? fromResponse(record.value, record.file, record.line) : !hasResponses && record.value.type === 'event_msg' ? fromEvent(record.value, record.file, record.line) : null;
    const messages = new Map();
    for (const record of allRecords) {
      const message = convert(record);
      if (message) messages.set(message.id, message);
    }
    const activeIds = [...new Set(activeRecords.map(convert).filter(Boolean).map(message => message.id))];
    if (!hasResponses && messages.size) issues.push('此版本只有事件记录，无法证明原文完整。');
    const meta = head.header.payload;
    threads.push({
      id, hostId: 'local', cwd: meta.cwd, title: meta.title ?? id, archived: head.file.includes(`${path.sep}archived_sessions${path.sep}`),
      messages: [...messages.values()], activeIds, localComplete: issues.length === 0, localWarnings: [...new Set(issues)],
      localSources: segments.map(segment => ({ file: segment.file, size: segment.bytes, segmentId: segment.segmentId, timestamp: segment.timestamp })),
      importedAt: now(), head: head.segmentId, excludedMessageIds: [...new Set(excludedMessageIds)]
    });
  }
  return { threads, warnings, home, excludedThreadIds: [...new Set(excludedThreadIds)] };
}

function mergeMessages(previous, incoming) {
  const map = new Map((previous ?? []).map(message => [message.id, message]));
  for (const message of incoming ?? []) {
    const old = map.get(message.id);
    if (!old) { map.set(message.id, message); continue; }
    const sources = [...new Map([...(old.sources ?? []), ...(message.sources ?? [])].map(source => [JSON.stringify(source), source])).values()];
    // 原文优于桌面摘要；同来源的新快照可补全仍在流式生成的消息。
    const incomingLocal = message.sources?.some(source => source.source === 'codex-local');
    const oldLocal = old.sources?.some(source => source.source === 'codex-local');
    const chooseIncoming = incomingLocal || (!oldLocal && message.text.length >= old.text.length);
    map.set(message.id, { ...(chooseIncoming ? message : old), sources });
  }
  return [...map.values()].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.id.localeCompare(b.id));
}

function emptyThread(id, hostId = 'local') {
  return { id, hostId, title: id, messages: [], activeIds: [], desktopPages: {}, localComplete: false, localWarnings: [], warnings: [] };
}

export function mergeThread(old, incoming) {
  const previous = old ?? emptyThread(incoming.id, incoming.hostId);
  const excluded = new Set(incoming.excludedMessageIds ?? []);
  const merged = { ...previous, ...incoming, messages: mergeMessages(previous.messages.filter(message => !excluded.has(message.id)), incoming.messages) };
  if (previous.title !== previous.id && incoming.title === incoming.id) merged.title = previous.title;
  if (!Object.hasOwn(incoming, 'localSources') && previous.localSources) {
    merged.activeIds = [...new Set([...previous.activeIds, ...(incoming.activeIds ?? [])])];
    merged.localComplete = previous.localComplete;
    if (merged.activeIds.some(id => !previous.activeIds.includes(id))) { merged.localComplete = false; merged.localWarnings = [...(previous.localWarnings ?? []), '桌面记录包含本地尚未核对的新消息。']; }
  }
  return merged;
}

const cursorKey = cursor => cursor === null ? 'first-page' : `cursor:${cursor}`;

function chainProgress(pages) {
  let cursor = null;
  const seen = new Set();
  for (;;) {
    const key = cursorKey(cursor);
    if (seen.has(key)) return { complete: false, nextCursor: cursor, issue: '分页游标存在循环。' };
    seen.add(key);
    const page = pages[key];
    if (!page) return { complete: false, nextCursor: cursor };
    if (page.nextCursor === null) return { complete: true, nextCursor: null };
    cursor = page.nextCursor;
  }
}

function desktopMessages(data) {
  const messages = [];
  for (const turn of [...(data.turns ?? [])].reverse()) {
    for (const item of turn.items ?? []) {
      const base = { id: item.id ?? `desktop-${hash([turn.id, item])}`, at: turn.startedAt ? new Date(turn.startedAt * 1000).toISOString() : null, turnId: turn.id, sources: [{ source: 'codex-desktop', turnId: turn.id, itemId: item.id }], truncated: true };
      if (item.type === 'userMessage') messages.push({ ...base, kind: 'message', role: 'user', ...contentParts(item.content) });
      else if (item.type === 'agentMessage' && item.phase !== 'analysis') messages.push({ ...base, kind: 'message', role: 'assistant', text: item.text ?? '', phase: item.phase, attachments: [] });
      else if (['commandExecution', 'mcpToolCall', 'toolCall', 'fileChange'].includes(item.type)) {
        const visible = { type: item.type, command: item.command, arguments: item.arguments, tool: item.tool, output: item.output ?? item.aggregatedOutput ?? item.result, status: item.status, exitCode: item.exitCode, changes: item.changes };
        messages.push({ ...base, id: `desktop-tool-${base.id}`, kind: 'tool', role: 'tool', text: JSON.stringify(visible), attachments: [] });
      }
    }
  }
  return messages;
}

async function desktopBelongs(project, info, envelopeProjectId) {
  const external = project.config.desktopProjectId;
  const claimed = info.projectId ?? envelopeProjectId;
  if (external && claimed && external !== claimed) return false;
  if (external && claimed === external) return true;
  return await belongsToProject(project, info.cwd);
}

export async function importData(project, options = {}) {
  const envelope = options.input ? unwrap(options.input) : null;
  if (envelope?.schemaVersion && envelope.schemaVersion !== 1) throw new Error('不支持此桌面导出版本。');
  if (envelope?.projectId && project.config.desktopProjectId && envelope.projectId !== project.config.desktopProjectId) throw new Error('导出文件属于另一个项目，已拒绝导入。');
  return withLock(project, async () => {
    project.config = await readJson(path.join(project.dir, 'config.json'));
    const local = options.local === false ? { threads: [], warnings: [], excludedThreadIds: [] } : await discoverLocal(project, options);
    const state = await readState(project), threads = await readThreads(project);
    let changedThreads = 0;
    for (const id of local.excludedThreadIds) {
      const key = threadKey(id);
      if (threads[key]) {
        const file = path.join(project.dir, 'transcripts', `${key}.jsonl`);
        await assertNoLink(project.primary, file);
        await fs.rm(file);
        delete threads[key]; delete state.processed[key];
      }
    }
    const save = async thread => {
      const key = threadKey(thread.id, thread.hostId);
      const comparable = value => { const copy = { ...value }; delete copy.importedAt; return copy; };
      if (JSON.stringify(comparable(thread)) !== JSON.stringify(comparable(threads[key] ?? {}))) {
        await writeThread(project, thread); threads[key] = thread; changedThreads++;
      }
    };
    for (const pageSpec of envelope?.inventoryPages ?? []) {
      const data = unwrap(pageSpec.data);
      if (!Array.isArray(data.threads) || !Object.hasOwn(data, 'nextCursor')) throw new Error('聊天清单必须包含 threads 和 nextCursor。');
      const scope = pageSpec.archived ? 'archived' : 'active';
      const runId = envelope.runId ?? 'default';
      let inventory = state.inventories[scope];
      if (!inventory || inventory.runId !== runId) inventory = { runId, pages: {} };
      const cursor = pageSpec.cursor ?? null;
      const found = [];
      for (const info of data.threads) {
        if (!await desktopBelongs(project, info, envelope.projectId)) continue;
        if (typeof info.id !== 'string' || !info.id) throw new Error('聊天清单中缺少有效标识。');
        const hostId = info.hostId ?? 'local', key = threadKey(info.id, hostId);
        found.push(key);
        const previous = threads[key] ?? emptyThread(info.id, hostId);
        await save({ ...previous, title: info.title ?? previous.title, cwd: info.cwd ?? previous.cwd, projectId: info.projectId, archived: Boolean(pageSpec.archived), discoveredByDesktop: true });
      }
      inventory.pages[cursorKey(cursor)] = { nextCursor: data.nextCursor ?? null, keys: found };
      Object.assign(inventory, chainProgress(inventory.pages), { updatedAt: now() });
      state.inventories[scope] = inventory;
    }
    const threadPages = envelope?.threadPages ?? (envelope?.thread && envelope?.turns ? [{ data: envelope, cursor: null }] : []);
    for (const pageSpec of threadPages) {
      const data = unwrap(pageSpec.data ?? pageSpec);
      const info = data.thread;
      if (!info?.id || !Array.isArray(data.turns) || !data.page) throw new Error('聊天页面必须包含 thread、page 和 turns。');
      const hostId = info.hostId ?? 'local', key = threadKey(info.id, hostId), old = threads[key];
      if (info.projectId && project.config.desktopProjectId && info.projectId !== project.config.desktopProjectId) throw new Error('聊天页面属于另一个桌面项目，已拒绝导入。');
      if (!await desktopBelongs(project, info, envelope?.projectId) && !old?.discoveredByDesktop) throw new Error('聊天页面无法证明属于当前项目。');
      const messages = desktopMessages(data);
      const previous = old ?? emptyThread(info.id, hostId);
      if (data.page.hasMore === true && !data.page.nextCursor) throw new Error('聊天页面声明仍有更多内容，但未提供下一页游标。');
      const pages = { ...previous.desktopPages, [cursorKey(pageSpec.cursor ?? null)]: { nextCursor: data.page.nextCursor ?? null } };
      const incoming = { id: info.id, hostId, title: info.title ?? previous.title, cwd: info.cwd ?? previous.cwd, messages, activeIds: [...new Set([...previous.activeIds, ...messages.map(message => message.id)])], desktopPages: pages, desktopProgress: chainProgress(pages), importedAt: now() };
      await save(mergeThread(previous, incoming));
    }
    for (const thread of local.threads) {
      const key = threadKey(thread.id, thread.hostId);
      await save(mergeThread(threads[key], thread));
    }
    state.scans.local = { checkedAt: now(), home: local.home, warnings: local.warnings, excludedInternalSessions: local.excludedThreadIds.length, scope: options.onlySessionId ? 'session' : 'project', sessionId: options.onlySessionId ?? null };
    await saveState(project, state);
    return { 项目: project.root, 发生更新的聊天数: changedThreads, 本次本地聊天数: local.threads.length, 提示: local.warnings, 说明: '原文归档已更新；提炼记忆请读取待整理内容后使用 record 写入。' };
  });
}

export function threadCoverage(thread) {
  if (!thread.messages.length) return 'unavailable';
  if (thread.localComplete) return 'complete';
  return 'partial';
}

export function pendingMessages(thread, state) {
  const key = threadKey(thread.id, thread.hostId), processed = state.processed[key] ?? {};
  const active = new Set(thread.activeIds);
  return thread.messages.filter(message => message.kind === 'message' && active.has(message.id) && processed[message.id] !== messageHash(message));
}
