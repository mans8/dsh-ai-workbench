/**
 * AI 工作台账 — 写操作。
 *
 * 所有状态变更都从这里过，面板与 Agent 工具调用完全相同的入口，
 * 因此不存在「面板能做的事工具做不了」或反过来。
 *
 * 约定：applyAction() 就地修改 state，返回
 *   { ok: true, message, result }  或  { ok: false, error }
 * 顺延补算由调用方（store.run）在此之前完成，所以这里看到的 plannedDate 已经对齐今天。
 *
 * ── 两套台账，互不写入（重要）─────────────────────────────────────
 * 「待办 / 流水」与「工时」是两件不同的事：
 *   待办：我每天要做的事；完成了就写一条事实流水（logs），用于统计与报表。
 *   工时：月底按领导派发填报的考勤台账（days），只由 hours_* 系列动作写入。
 * 因此这里有一条硬约束：**任何 todo_* / log_* 动作都不许碰 state.days**。
 * 待办完成不给工时，撤销也不回收工时；两者靠日期各自独立对账。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dayKind, holidayNameOf, isWorkday } from './calendar.js';
import {
  DEFAULT_SETTINGS,
  DAY_STATUS,
  MAX_TICKET_HOURS,
  REPORT_STATUS,
  ROLLOVER,
  TODO_STATUS,
  activeLogs,
  dayRecord,
  materializeRecurring,
  reportById,
  todoById,
} from './state.js';
import { buildReport, renderReport } from './reports.js';
import {
  clampInt,
  clampNum,
  compareKey,
  dayKeyOf,
  eachDay,
  fmtHours,
  isKey,
  monthKeyOf,
  monthRange,
  normalizeKey,
  nowIso,
  uid,
} from './util.js';

/* ------------------------------------------------------------------ *
 * 查找辅助
 * ------------------------------------------------------------------ */

/** 按 id 或标题（支持部分匹配）找待办。 */
export function findTodo(state, ref, options = {}) {
  if (ref === null || ref === undefined || ref === '') return null;
  const needle = String(ref).trim();
  const direct = state.todos.find((item) => item.id === needle);
  if (direct) return direct;
  const lower = needle.toLowerCase();
  const pool = state.todos.filter((item) => (options.includeTemplates ? true : !item.isTemplate));
  const exact = pool.filter((item) => item.title.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = pool.filter((item) => item.title.toLowerCase().includes(lower));
  const candidates = partial.length > 0 ? partial : exact;
  if (candidates.length === 0) return null;
  const open = candidates.filter((item) => item.status === TODO_STATUS.OPEN);
  const pick = (open.length > 0 ? open : candidates).slice();
  pick.sort((a, b) => compareKey(b.updatedAt, a.updatedAt));
  return pick[0];
}

/**
 * 从 payload 里取出项目引用。
 * 空串要当成「没给」——否则 `projectId ?? project` 会被空串短路，
 * 变成「拿着空字符串去找项目」，用户的 `project` 参数就静默失效了。
 */
function projectRefOf(payload) {
  const id = typeof payload.projectId === 'string' && payload.projectId.trim() !== '' ? payload.projectId.trim() : null;
  const name = typeof payload.project === 'string' && payload.project.trim() !== '' ? payload.project.trim() : null;
  return id ?? name;
}

/** 按 id / 名称 / 代号找项目。 */
export function findProject(state, ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  const needle = String(ref).trim();
  const direct = state.projects.find((item) => item.id === needle);
  if (direct) return direct;
  const lower = needle.toLowerCase();
  const byName = state.projects.filter((item) => item.name.toLowerCase() === lower || (item.code && item.code.toLowerCase() === lower));
  if (byName.length === 1) return byName[0];
  const partial = state.projects.filter((item) => item.name.toLowerCase().includes(lower));
  const candidates = partial.length > 0 ? partial : byName;
  if (candidates.length === 0) return null;
  const active = candidates.filter((item) => item.status === 'active');
  return (active.length > 0 ? active : candidates)[0];
}

/* ------------------------------------------------------------------ *
 * 事实层 / 口径层写入
 * ------------------------------------------------------------------ */

/** 追加一条事实流水。 */
function pushLog(state, fields) {
  const log = {
    id: uid('lg'),
    date: normalizeKey(fields.date),
    at: nowIso(),
    title: String(fields.title ?? '').slice(0, 300),
    projectId: fields.projectId ?? null,
    todoId: fields.todoId ?? null,
    hours: clampNum(fields.hours, 0, 24, 0),
    note: String(fields.note ?? '').slice(0, 2000),
    source: fields.source ?? 'manual',
    rolloverCount: clampInt(fields.rolloverCount, 0, 9999, 0),
    voided: false,
    voidedAt: null,
  };
  state.logs.push(log);
  return log;
}

/** 某天既没有分条记录、也没有整天填报时，把这一天的壳也去掉。 */
function dropEmptyDay(state, date) {
  const record = state.days[date];
  if (!record) return;
  const manual = record.manualHours !== null && record.manualHours !== undefined;
  if (record.entries.length === 0 && !manual && record.status === DAY_STATUS.NORMAL) delete state.days[date];
}

/**
 * 追加一条工时条目。
 *
 * 这是**唯一**往工时台账里写数据的地方（连同整日填报）。它不接受 todoId / logId：
 * 工时不属于某条待办或某条流水，它只属于「某一天 + 某个项目」。
 */
function pushHoursEntry(state, date, fields) {
  const record = dayRecord(state, date, true);
  const entry = {
    id: uid('we'),
    projectId: fields.projectId ?? null,
    todoId: null,
    logId: null,
    ticketId: fields.ticketId ?? null,
    hours: clampNum(fields.hours, 0, MAX_TICKET_HOURS, 0),
    note: String(fields.note ?? '').slice(0, 500),
    at: nowIso(),
  };
  record.entries.push(entry);
  // 一旦有分条记录，就放弃整天填报的口径，避免两套数字互相遮蔽。
  record.manualHours = null;
  return entry;
}

/* ------------------------------------------------------------------ *
 * 工单（工时台账的「按单」视角）
 * ------------------------------------------------------------------ */

/**
 * 让「工单」和「工时条目」始终一一对应。
 *
 * 工单是有小时数的，这些小时必须落进工时台账（days），否则页面会出现两个互相打架的数字：
 * 表格里工单合计 22h、上面却写着已录 0h。所以录入工单时同步推一条带 ticketId 的条目，
 * 改小时数就重推，删工单就收回 —— 台账仍然只有一份。
 */
function syncTicketEntry(state, ticket) {
  for (const [key, record] of Object.entries(state.days)) {
    const before = record.entries.length;
    record.entries = record.entries.filter((entry) => entry.ticketId !== ticket.id);
    if (record.entries.length !== before) dropEmptyDay(state, key);
  }
  const hours = Number(ticket.hours);
  if (!Number.isFinite(hours) || hours <= 0) return;
  pushHoursEntry(state, ticket.date, {
    hours,
    projectId: ticket.projectId,
    note: ticket.title,
    ticketId: ticket.id,
  });
}

function ticketCreate(state, today, payload) {
  const title = String(payload.title ?? payload.task ?? payload.issue ?? '').trim();
  if (!title) return { ok: false, error: '工单标题不能为空' };
  const projectRef = projectRefOf(payload);
  const project = projectRef ? findProject(state, projectRef) : null;
  if (projectRef && !project) return { ok: false, error: `找不到项目「${projectRef}」` };
  if (payload.type !== undefined && payload.type !== '' && typeof payload.type !== 'string') {
    return { ok: false, error: '工单类型必须是 20 字以内的文字' };
  }
  const date = isKey(payload.date) ? payload.date : today;
  const hoursRaw = payload.hours === undefined || payload.hours === null || payload.hours === '' ? null : Number(payload.hours);
  if (hoursRaw !== null && (!Number.isFinite(hoursRaw) || hoursRaw < 0 || hoursRaw > MAX_TICKET_HOURS)) {
    return { ok: false, error: `工时只能是 0~${MAX_TICKET_HOURS} 之间的数字，留空表示「无工时」` };
  }

  const stamp = nowIso();
  const ticket = {
    id: uid('tk'),
    date,
    type: typeof payload.type === 'string' ? payload.type.trim().slice(0, 20) : '',
    projectId: project?.id ?? null,
    url: String(payload.url ?? payload.link ?? '').slice(0, 500),
    title: title.slice(0, 300),
    hours: hoursRaw,
    note: String(payload.note ?? '').slice(0, 200),
    createdAt: stamp,
    updatedAt: stamp,
  };
  state.tickets.push(ticket);
  syncTicketEntry(state, ticket);

  const hoursText = ticket.hours === null ? '无工时' : fmtHours(ticket.hours);
  return {
    ok: true,
    message: `🎫 已记工单「${ticket.title}」（${hoursText}）`,
    result: { id: ticket.id, ticket },
  };
}

function ticketUpdate(state, today, payload) {
  const ticket = state.tickets.find((item) => item.id === (payload.id ?? payload.ticket)) ?? null;
  if (!ticket) return { ok: false, error: '找不到这条工单' };
  const touched = [];
  // 编辑器会把所有字段一起提交，提示语只报真正变了的那些
  const before = JSON.stringify([ticket.type, ticket.date, ticket.projectId, ticket.hours, ticket.title, ticket.url, ticket.note]);

  if (payload.title !== undefined) {
    const title = String(payload.title).trim();
    if (!title) return { ok: false, error: '工单标题不能为空' };
    ticket.title = title.slice(0, 300);
    touched.push('标题');
  }
  if (payload.type !== undefined) {
    if (payload.type !== '' && typeof payload.type !== 'string') {
      return { ok: false, error: '类型必须是 20 字以内的文字' };
    }
    ticket.type = typeof payload.type === 'string' ? payload.type.trim().slice(0, 20) : '';
    touched.push('类型');
  }
  if (payload.url !== undefined || payload.link !== undefined) {
    ticket.url = String(payload.url ?? payload.link ?? '').slice(0, 500);
    touched.push('链接');
  }
  if (payload.projectId !== undefined || payload.project !== undefined) {
    const ref = projectRefOf(payload);
    if (!ref) {
      ticket.projectId = null;
    } else {
      const project = findProject(state, ref);
      if (!project) return { ok: false, error: `找不到项目「${ref}」` };
      ticket.projectId = project.id;
    }
    touched.push('项目');
  }
  if (payload.date !== undefined) {
    ticket.date = isKey(payload.date) ? payload.date : today;
    touched.push('日期');
  }
  if (payload.hours !== undefined) {
    if (payload.hours === null || payload.hours === '') {
      ticket.hours = null;
    } else {
      const value = Number(payload.hours);
      if (!Number.isFinite(value) || value < 0 || value > MAX_TICKET_HOURS) {
        return { ok: false, error: `工时只能是 0~${MAX_TICKET_HOURS} 之间的数字` };
      }
      ticket.hours = value;
    }
    touched.push('工时');
  }
  if (payload.note !== undefined) {
    ticket.note = String(payload.note).slice(0, 200);
    touched.push('备注');
  }

  if (touched.length === 0) return { ok: false, error: '没有需要修改的字段' };
  ticket.updatedAt = nowIso();
  syncTicketEntry(state, ticket);
  const after = JSON.stringify([ticket.type, ticket.date, ticket.projectId, ticket.hours, ticket.title, ticket.url, ticket.note]);
  const labels = ['类型', '日期', '项目', '工时', '标题', '链接', '备注'];
  const parsedBefore = JSON.parse(before);
  const parsedAfter = JSON.parse(after);
  const changed = labels.filter((label, index) => JSON.stringify(parsedBefore[index]) !== JSON.stringify(parsedAfter[index]));
  return {
    ok: true,
    message: changed.length ? `已更新工单「${ticket.title}」：${changed.join('、')}` : `工单「${ticket.title}」没有任何改动`,
    result: { id: ticket.id, ticket },
  };
}

function ticketRemove(state, today, payload) {
  const ticket = state.tickets.find((item) => item.id === (payload.id ?? payload.ticket)) ?? null;
  if (!ticket) return { ok: false, error: '找不到这条工单' };
  state.tickets = state.tickets.filter((item) => item.id !== ticket.id);
  syncTicketEntry(state, { ...ticket, hours: null }); // 只回收工时条目
  return { ok: true, message: `已删除工单「${ticket.title}」`, result: { id: ticket.id } };
}

/* ------------------------------------------------------------------ *
 * 待办
 * ------------------------------------------------------------------ */

/** 新建待办（带 repeat 时建成重复任务模板，并立刻开出今天这一条）。 */
function todoCreate(state, today, payload) {
  const title = String(payload.title ?? payload.name ?? '').trim();
  if (!title) return { ok: false, error: '待办标题不能为空' };
  const projectRef = projectRefOf(payload);
  const project = projectRef ? findProject(state, projectRef) : null;
  if (projectRef && !project) return { ok: false, error: `找不到项目「${projectRef}」` };

  const repeat = payload.repeat && typeof payload.repeat === 'object' ? payload.repeat : null;
  const kind = repeat ? 'recurring' : 'once';
  const stamp = nowIso();
  const plannedDate = isKey(payload.plannedDate) ? payload.plannedDate : today;

  const todo = {
    id: uid('td'),
    title: title.slice(0, 200),
    note: String(payload.note ?? '').slice(0, 2000),
    projectId: project?.id ?? null,
    priority: ['P0', 'P1', 'P2', 'P3'].includes(payload.priority) ? payload.priority : 'P2',
    tags: Array.isArray(payload.tags) ? payload.tags.filter((t) => typeof t === 'string').slice(0, 20) : [],
    kind,
    isTemplate: kind === 'recurring',
    repeat: kind === 'recurring' ? repeat : null,
    templateId: null,
    plannedDate: kind === 'recurring' ? null : plannedDate,
    firstPlannedDate: kind === 'recurring' ? null : plannedDate,
    dueDate: isKey(payload.dueDate) ? payload.dueDate : null,
    estimateHours: payload.estimateHours === null || payload.estimateHours === undefined ? null : clampNum(payload.estimateHours, 0, 24, null),
    progress: clampInt(payload.progress, 0, 100, 0),
    rollover: [ROLLOVER.ALWAYS, ROLLOVER.BACKLOG, ROLLOVER.NEVER].includes(payload.rollover) ? payload.rollover : ROLLOVER.INHERIT,
    status: TODO_STATUS.OPEN,
    archived: false,
    backlog: payload.backlog === true,
    rolloverCount: 0,
    createdAt: stamp,
    updatedAt: stamp,
    completedAt: null,
    completedDate: null,
    droppedAt: null,
    dropReason: null,
    missedDate: null,
    logId: null,
  };
  state.todos.push(todo);

  const events = { days: 0, moved: [], missed: [], created: [] };
  if (kind === 'recurring') {
    // 模板建好后立刻物化今天（以及今天之前没开出来的不补，从今天开始）。
    materializeRecurring(state, today, events);
  }

  const created = events.created.length;
  return {
    ok: true,
    message: kind === 'recurring' ? `已新建重复任务「${todo.title}」${created > 0 ? `，并开出今天这 1 条` : ''}` : `已新建待办「${todo.title}」（${plannedDate}）`,
    result: { id: todo.id, created, todo },
  };
}

/** 更新待办字段。 */
function todoUpdate(state, today, payload) {
  const todo = findTodo(state, payload.id ?? payload.task, { includeTemplates: true });
  if (!todo) return { ok: false, error: '找不到这条待办' };
  const touched = [];
  // 编辑器会把所有字段一起提交，所以「哪些字段被识别」和「哪些字段真变了」是两件事。
  // 提示语只报后者，否则每次保存都会列出全部字段，看不出到底改了什么。
  const before = JSON.stringify([
    todo.title,
    todo.note,
    todo.projectId,
    todo.priority,
    todo.tags,
    todo.plannedDate,
    todo.dueDate,
    todo.estimateHours,
    todo.progress,
    todo.rollover,
    todo.repeat,
    todo.archived,
  ]);

  if (payload.title !== undefined) {
    const title = String(payload.title).trim();
    if (!title) return { ok: false, error: '标题不能为空' };
    todo.title = title.slice(0, 200);
    touched.push('标题');
  }
  if (payload.note !== undefined) {
    todo.note = String(payload.note).slice(0, 2000);
    touched.push('备注');
  }
  if (payload.projectId !== undefined || payload.project !== undefined) {
    const ref = projectRefOf(payload);
    if (!ref) {
      todo.projectId = null;
    } else {
      const project = findProject(state, ref);
      if (!project) return { ok: false, error: `找不到项目「${ref}」` };
      todo.projectId = project.id;
    }
    touched.push('项目');
  }
  if (payload.priority !== undefined) {
    if (!['P0', 'P1', 'P2', 'P3'].includes(payload.priority)) return { ok: false, error: '优先级只能是 P0~P3' };
    todo.priority = payload.priority;
    touched.push('优先级');
  }
  if (payload.tags !== undefined) {
    todo.tags = Array.isArray(payload.tags) ? payload.tags.filter((t) => typeof t === 'string').slice(0, 20) : [];
    touched.push('标签');
  }
  if (payload.plannedDate !== undefined && !todo.isTemplate) {
    todo.plannedDate = isKey(payload.plannedDate) ? payload.plannedDate : today;
    if (!todo.firstPlannedDate) todo.firstPlannedDate = todo.plannedDate;
    todo.backlog = false;
    touched.push('计划日');
  }
  if (payload.dueDate !== undefined) {
    todo.dueDate = isKey(payload.dueDate) ? payload.dueDate : null;
    touched.push('截止日');
  }
  if (payload.estimateHours !== undefined) {
    todo.estimateHours = payload.estimateHours === null ? null : clampNum(payload.estimateHours, 0, 24, null);
    touched.push('预估工时');
  }
  if (payload.progress !== undefined) {
    if (payload.progress === null) {
      todo.progress = 0;
    } else {
      const value = Number(payload.progress);
      if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false, error: '进度只能是 0~100 的数字' };
      todo.progress = clampInt(value, 0, 100, 0);
    }
    touched.push('进度');
  }
  if (payload.rollover !== undefined) {
    if (!Object.values(ROLLOVER).includes(payload.rollover)) return { ok: false, error: '顺延策略只能是 always / backlog / never / inherit' };
    todo.rollover = payload.rollover;
    touched.push('顺延策略');
  }
  if (payload.repeat !== undefined && todo.kind === 'recurring') {
    todo.repeat = payload.repeat && typeof payload.repeat === 'object' ? payload.repeat : todo.repeat;
    touched.push('重复规则');
  }
  if (payload.enabled !== undefined && todo.isTemplate) {
    todo.archived = payload.enabled === false;
    if (todo.archived) {
      // 停用模板时，把还没做的实例一并收掉，避免留下孤儿。
      for (const item of state.todos) {
        if (item.templateId === todo.id && item.status === TODO_STATUS.OPEN) {
          item.status = TODO_STATUS.DROPPED;
          item.dropReason = '模板停用';
          item.droppedAt = nowIso();
        }
      }
    } else {
      const events = { days: 0, moved: [], missed: [], created: [] };
      materializeRecurring(state, today, events);
    }
    touched.push(payload.enabled === false ? '停用' : '启用');
  }

  if (touched.length === 0) return { ok: false, error: '没有需要修改的字段' };
  todo.updatedAt = nowIso();
  const after = JSON.stringify([
    todo.title,
    todo.note,
    todo.projectId,
    todo.priority,
    todo.tags,
    todo.plannedDate,
    todo.dueDate,
    todo.estimateHours,
    todo.progress,
    todo.rollover,
    todo.repeat,
    todo.archived,
  ]);
  const labels = ['标题', '备注', '项目', '优先级', '标签', '计划日', '截止日', '预估工时', '进度', '顺延策略', '重复规则', todo.archived ? '停用' : '启用'];
  const changed = labels.filter((label, index) => {
    const a = JSON.parse(before)[index];
    const b = JSON.parse(after)[index];
    return JSON.stringify(a) !== JSON.stringify(b);
  });
  return {
    ok: true,
    message: changed.length ? `已更新「${todo.title}」：${changed.join('、')}` : `「${todo.title}」没有任何改动`,
    result: { id: todo.id, todo },
  };
}

/** 删除待办（软删：归档，历史流水保留）。 */
function todoDelete(state, today, payload) {
  const todo = findTodo(state, payload.id ?? payload.task, { includeTemplates: true });
  if (!todo) return { ok: false, error: '找不到这条待办' };
  todo.archived = true;
  todo.updatedAt = nowIso();
  // 模板被归档时，未完成的实例一并归档。
  if (todo.isTemplate) {
    for (const item of state.todos) {
      if (item.templateId === todo.id && item.status === TODO_STATUS.OPEN) {
        item.archived = true;
        item.updatedAt = nowIso();
      }
    }
  }
  return { ok: true, message: `已删除「${todo.title}」（历史流水保留）`, result: { id: todo.id } };
}

/**
 * 完成待办：**只**写一条事实流水。
 *
 * 刻意不接受 hours：待办是「这件事做完了没有」，工时是月底的考勤台账，
 * 两者不挂钩。要记工时就到工时页记一条**工单**（带小时数的那种）。
 */
function todoComplete(state, today, payload) {
  const todo = findTodo(state, payload.id ?? payload.task, { includeTemplates: true });
  if (!todo) return { ok: false, error: '找不到这条待办' };
  if (todo.isTemplate) return { ok: false, error: '这是重复任务模板，请在它开出的实例上完成' };
  if (todo.status === TODO_STATUS.DONE) {
    return { ok: true, message: `「${todo.title}」已经完成过了`, result: { id: todo.id, already: true } };
  }

  const date = isKey(payload.date) ? payload.date : today;
  const note = payload.note !== undefined ? String(payload.note).slice(0, 2000) : todo.note;

  const log = pushLog(state, {
    date,
    title: todo.title,
    projectId: todo.projectId,
    todoId: todo.id,
    hours: 0, // 流水不承载工时，工时只在 days 里
    note,
    source: 'todo',
    rolloverCount: todo.rolloverCount,
  });

  todo.status = TODO_STATUS.DONE;
  todo.completedAt = nowIso();
  todo.completedDate = date;
  todo.backlog = false;
  todo.logId = log.id;
  todo.updatedAt = nowIso();

  const carried = todo.rolloverCount > 0 ? `（顺延 ${todo.rolloverCount} 天后完成）` : '';
  return {
    ok: true,
    message: `✅ 完成「${todo.title}」${carried}`,
    result: { id: todo.id, logId: log.id },
  };
}

/**
 * 撤销完成：只把那条事实流水软删。
 *
 * 刻意**不**回收工时：工时是独立台账，撤掉一条待办不应该动考勤数字。
 */
function todoUndo(state, today, payload) {
  const todo = findTodo(state, payload.id ?? payload.task, { includeTemplates: true });
  if (!todo) return { ok: false, error: '找不到这条待办' };
  if (todo.status !== TODO_STATUS.DONE) return { ok: false, error: `「${todo.title}」当前不是已完成状态` };

  const log = (payload.logId ? state.logs.find((item) => item.id === payload.logId) : null)
    ?? (todo.logId ? state.logs.find((item) => item.id === todo.logId) : null);
  if (log && !log.voided) {
    log.voided = true;
    log.voidedAt = nowIso();
  }

  todo.status = TODO_STATUS.OPEN;
  todo.completedAt = null;
  todo.completedDate = null;
  todo.logId = null;
  // 撤销后回到「今天」，否则它会被下一次顺延立刻推到明天。
  if (!todo.plannedDate || compareKey(todo.plannedDate, today) < 0) todo.plannedDate = today;
  todo.updatedAt = nowIso();

  return {
    ok: true,
    message: `↩️ 已撤销「${todo.title}」`,
    result: { id: todo.id, logId: log?.id ?? null },
  };
}

/** 放弃待办（带理由，进入放弃率统计）。 */
function todoDrop(state, today, payload) {
  const todo = findTodo(state, payload.id ?? payload.task, { includeTemplates: true });
  if (!todo) return { ok: false, error: '找不到这条待办' };
  if (todo.status === TODO_STATUS.DROPPED) return { ok: true, message: `「${todo.title}」已经放弃了`, result: { id: todo.id } };
  todo.status = TODO_STATUS.DROPPED;
  todo.dropReason = String(payload.reason ?? '不做').slice(0, 100);
  todo.droppedAt = nowIso();
  todo.backlog = false;
  todo.updatedAt = nowIso();
  return { ok: true, message: `✖️ 已放弃「${todo.title}」（${todo.dropReason}）`, result: { id: todo.id } };
}

/** 恢复被放弃/归档的待办。 */
function todoRestore(state, today, payload) {
  const todo = findTodo(state, payload.id ?? payload.task, { includeTemplates: true });
  if (!todo) return { ok: false, error: '找不到这条待办' };
  todo.status = TODO_STATUS.OPEN;
  todo.archived = false;
  todo.dropReason = null;
  todo.droppedAt = null;
  todo.missedDate = null;
  todo.backlog = false;
  if (!todo.isTemplate) todo.plannedDate = isKey(payload.plannedDate) ? payload.plannedDate : today;
  todo.updatedAt = nowIso();
  return { ok: true, message: `已恢复「${todo.title}」`, result: { id: todo.id } };
}

/** 改期 / 转积压 / 拉回今天。 */
function todoReschedule(state, today, payload) {
  const todo = findTodo(state, payload.id ?? payload.task, { includeTemplates: true });
  if (!todo) return { ok: false, error: '找不到这条待办' };
  if (todo.isTemplate) return { ok: false, error: '模板本身没有计划日，请改它的重复规则' };

  if (payload.toBacklog === true) {
    todo.backlog = true;
    todo.updatedAt = nowIso();
    return { ok: true, message: `📥 已把「${todo.title}」转入积压`, result: { id: todo.id, backlog: true } };
  }
  if (payload.toToday === true) {
    todo.plannedDate = today;
    todo.backlog = false;
    todo.updatedAt = nowIso();
    return { ok: true, message: `📌 已把「${todo.title}」拉回今天`, result: { id: todo.id, plannedDate: today } };
  }

  let next = null;
  if (isKey(payload.plannedDate)) next = payload.plannedDate;
  else if (payload.deltaDays !== undefined) {
    const delta = clampInt(payload.deltaDays, -365, 365, 0);
    const base = todo.plannedDate ?? today;
    const dt = new Date(`${base}T12:00:00`);
    dt.setDate(dt.getDate() + delta);
    next = dayKeyOf(dt);
  }
  if (!next) return { ok: false, error: '请给出 plannedDate、deltaDays、toBacklog 或 toToday 之一' };

  todo.plannedDate = next;
  todo.backlog = false;
  if (!todo.firstPlannedDate) todo.firstPlannedDate = next;
  todo.updatedAt = nowIso();
  return { ok: true, message: `已把「${todo.title}」改到 ${next}`, result: { id: todo.id, plannedDate: next } };
}

/* ------------------------------------------------------------------ *
 * 项目
 * ------------------------------------------------------------------ */

function projectCreate(state, today, payload) {
  const name = String(payload.name ?? payload.title ?? '').trim();
  if (!name) return { ok: false, error: '项目名不能为空' };
  const stamp = nowIso();
  const project = {
    id: uid('pj'),
    name: name.slice(0, 60),
    code: String(payload.code ?? '').slice(0, 20),
    emoji: String(payload.emoji ?? '📁').slice(0, 8),
    color: String(payload.color ?? '#3FA88F').slice(0, 20),
    status: ['active', 'paused', 'archived'].includes(payload.status) ? payload.status : 'active',
    owner: String(payload.owner ?? '').slice(0, 40),
    startedAt: isKey(payload.startedAt) ? payload.startedAt : null,
    endedAt: isKey(payload.endedAt) ? payload.endedAt : null,
    description: String(payload.description ?? '').slice(0, 500),
    createdAt: stamp,
    updatedAt: stamp,
    archivedAt: null,
  };
  state.projects.push(project);
  return { ok: true, message: `已新建项目 ${project.emoji} ${project.name}`, result: { id: project.id, project } };
}

function projectUpdate(state, today, payload) {
  const project = findProject(state, payload.id ?? payload.project ?? payload.name);
  if (!project) return { ok: false, error: '找不到这个项目' };
  const touched = [];
  // 编辑器会把所有字段一起提交，所以「识别到哪些字段」和「哪些真变了」要分开算，
  // 提示语只报后者 —— 跟 todo_update 一个道理。
  const before = JSON.stringify([
    project.name,
    project.code,
    project.emoji,
    project.color,
    project.owner,
    project.description,
    project.status,
    project.startedAt,
    project.endedAt,
  ]);
  for (const [field, label] of [
    ['name', '名称'],
    ['code', '代号'],
    ['emoji', '图标'],
    ['color', '颜色'],
    ['owner', '负责人'],
    ['description', '说明'],
  ]) {
    if (payload[field] !== undefined) {
      project[field] = String(payload[field]).slice(0, field === 'description' ? 500 : 60);
      touched.push(label);
    }
  }
  if (payload.status !== undefined) {
    if (!['active', 'paused', 'archived'].includes(payload.status)) return { ok: false, error: '状态只能是 active / paused / archived' };
    project.status = payload.status;
    project.archivedAt = payload.status === 'archived' ? nowIso() : null;
    touched.push('状态');
  }
  if (payload.startedAt !== undefined) {
    project.startedAt = isKey(payload.startedAt) ? payload.startedAt : null;
    touched.push('启动日');
  }
  if (payload.endedAt !== undefined) {
    project.endedAt = isKey(payload.endedAt) ? payload.endedAt : null;
    touched.push('结束日');
  }
  if (touched.length === 0) return { ok: false, error: '没有需要修改的字段' };
  project.updatedAt = nowIso();
  const after = JSON.stringify([
    project.name,
    project.code,
    project.emoji,
    project.color,
    project.owner,
    project.description,
    project.status,
    project.startedAt,
    project.endedAt,
  ]);
  const labels = ['名称', '代号', '图标', '颜色', '负责人', '说明', '状态', '启动日', '结束日'];
  const parsedBefore = JSON.parse(before);
  const parsedAfter = JSON.parse(after);
  const changed = labels.filter((label, index) => JSON.stringify(parsedBefore[index]) !== JSON.stringify(parsedAfter[index]));
  return {
    ok: true,
    message: changed.length ? `已更新项目「${project.name}」：${changed.join('、')}` : `「${project.name}」没有任何改动`,
    result: { id: project.id, project },
  };
}

function projectDelete(state, today, payload) {
  const project = findProject(state, payload.id ?? payload.project ?? payload.name);
  if (!project) return { ok: false, error: '找不到这个项目' };
  const hard = payload.hard === true;
  if (hard) {
    const attached = state.todos.filter((item) => item.projectId === project.id).length;
    const logged = activeLogs(state).filter((log) => log.projectId === project.id).length;
    if (attached > 0 || logged > 0) {
      return { ok: false, error: `该项目下还有 ${attached} 条待办、${logged} 条流水，不能硬删除；请改用归档` };
    }
    state.projects = state.projects.filter((item) => item.id !== project.id);
    return { ok: true, message: `已删除项目「${project.name}」`, result: { id: project.id } };
  }
  project.status = 'archived';
  project.archivedAt = nowIso();
  project.updatedAt = nowIso();
  return { ok: true, message: `已归档项目「${project.name}」`, result: { id: project.id } };
}

/* ------------------------------------------------------------------ *
 * 工时
 *
 * **工时的唯一来源是工单。** 没有「逐条记工时」「整天填报」「月底批量填报」这些入口了 ——
 * 想在某个日期上体现工时，就去记一条带小时数的工单，它会自动落进 state.days。
 * 这里只保留了与小时数无关的出勤标记（请假 / 半天假 / 加班）。
 * ------------------------------------------------------------------ */

function guardDate(date, today) {
  if (compareKey(date, today) > 0) return { ok: false, error: `不能给未来的日期（${date}）记工时` };
  return null;
}

function hoursMark(state, today, payload) {
  const date = isKey(payload.date) ? payload.date : null;
  if (!date) return { ok: false, error: '请给出 date' };
  const status = Object.values(DAY_STATUS).includes(payload.status) ? payload.status : null;
  if (!status) return { ok: false, error: 'status 只能是 normal / leave / half-leave / overtime' };
  const record = dayRecord(state, date, true);
  record.status = status;
  if (payload.note !== undefined) record.note = String(payload.note).slice(0, 500);
  const label = { normal: '正常', leave: '请假', 'half-leave': '半天假', overtime: '加班' }[status];
  return { ok: true, message: `已把 ${date} 标记为「${label}」`, result: { date, status } };
}

/**
 * 随手记：不建待办，直接记一条发生的事。
 *
 * 属于「流水」这一层，所以同样不写工时 —— 要记工时就到工时页记。
 */
function logNote(state, today, payload) {
  const date = isKey(payload.date) ? payload.date : today;
  const guard = guardDate(date, today);
  if (guard) return guard;
  const title = String(payload.title ?? payload.note ?? '').trim();
  if (!title) return { ok: false, error: '随手记必须有内容' };
  const projectRef = projectRefOf(payload);
  const project = projectRef ? findProject(state, projectRef) : null;
  if (projectRef && !project) return { ok: false, error: `找不到项目「${projectRef}」` };
  const log = pushLog(state, {
    date,
    title,
    projectId: project?.id ?? null,
    hours: 0,
    note: payload.note && payload.note !== title ? payload.note : '',
    source: 'manual',
  });
  return { ok: true, message: `📝 已记下「${title}」`, result: { id: log.id, date } };
}

/** 作废一条随手记（不牵动工时台账）。 */
function logRemove(state, today, payload) {
  const log = state.logs.find((item) => item.id === payload.id || item.id === payload.logId);
  if (!log) return { ok: false, error: '找不到这条记录' };
  log.voided = true;
  log.voidedAt = nowIso();
  if (log.todoId) {
    const todo = todoById(state, log.todoId);
    if (todo && todo.logId === log.id) {
      todo.status = TODO_STATUS.OPEN;
      todo.completedAt = null;
      todo.completedDate = null;
      todo.logId = null;
    }
  }
  return { ok: true, message: `已作废「${log.title}」`, result: { id: log.id } };
}

/* ------------------------------------------------------------------ *
 * 报表
 * ------------------------------------------------------------------ */

function reportCreate(state, today, payload) {
  const projectRef = projectRefOf(payload);
  const project = projectRef ? findProject(state, projectRef) : null;
  if (projectRef && !project) return { ok: false, error: `找不到项目「${projectRef}」` };
  const opts = {
    type: payload.type,
    date: payload.date,
    from: payload.from,
    to: payload.to,
    projectId: project?.id ?? null,
    today,
    generatedBy: payload.generatedBy ?? 'ai-workbench',
  };
  if (opts.type === 'project' && !opts.projectId) return { ok: false, error: '项目维度的报表必须指定 projectId' };

  const built = buildReport(state, opts);
  const stamp = nowIso();
  const report = {
    id: uid('rp'),
    type: built.range.type,
    dimension: built.range.dimension,
    projectId: built.range.projectId,
    from: built.range.from,
    to: built.range.to,
    title: payload.title ? String(payload.title).slice(0, 200) : built.title,
    status: REPORT_STATUS.DRAFT,
    revision: 1,
    content: payload.content !== undefined ? String(payload.content) : built.content,
    facts: built.facts,
    createdAt: stamp,
    updatedAt: stamp,
    finalizedAt: null,
    archivedAt: null,
    supersedes: null,
  };
  state.reports.push(report);
  return {
    ok: true,
    message: `已生成草稿《${report.title}》：${built.facts.totals.done} 项完成 / ${fmtHours(built.facts.legs.loggedHours)}`,
    result: { id: report.id, report },
  };
}

function reportSave(state, today, payload) {
  const report = reportById(state, payload.id ?? payload.reportId);
  if (!report) return { ok: false, error: '找不到这份报表' };
  if (report.status === REPORT_STATUS.ARCHIVED) {
    return { ok: false, error: '已归档的报表不可修改；请用「修订」生成新版本' };
  }
  if (payload.content !== undefined) report.content = String(payload.content);
  if (payload.title !== undefined) report.title = String(payload.title).slice(0, 200);
  if (payload.status !== undefined) {
    if (![REPORT_STATUS.DRAFT, REPORT_STATUS.FINAL].includes(payload.status)) {
      return { ok: false, error: '只能保存为 draft 或 final；归档请用 report_archive' };
    }
    report.status = payload.status;
    report.finalizedAt = payload.status === REPORT_STATUS.FINAL ? nowIso() : null;
  }
  report.updatedAt = nowIso();
  return { ok: true, message: `已保存《${report.title}》`, result: { id: report.id, report } };
}

/**
 * 找出文件里**第一条周报**的起始位置，用来把新条目插在它前面。
 * 认两种写法：Markdown 的 `#### 2026.09.14-2026.09.18`，和纯文本的 `2026.08.17-2026.08.21-小组`。
 * 找不到就返回 -1（新文件 / 空文件）。
 */
const ENTRY_LINE = /^(?:#{1,6}\s*)?\d{4}\.\d{2}\.\d{2}\s*-\s*\d{4}\.\d{2}\.\d{2}/m;

function firstEntryIndex(text) {
  if (!text) return -1;
  const match = ENTRY_LINE.exec(text);
  if (!match) return -1;
  let at = match.index;
  // 纯文本里条目上面往往压着一行分隔线（-----），那行也算本条的一部分，一起往后让
  const before = text.slice(0, at);
  const lastBreak = before.lastIndexOf('\n', before.length - 2);
  const prevLine = before.slice(lastBreak + 1).trim();
  if (prevLine && /^-{3,}$/.test(prevLine)) at = lastBreak + 1;
  return at;
}

/** 2026-09-14 → 2026.09.14（周报文件里用的日期写法）。 */
function dotDate(key) {
  return String(key).replace(/-/g, '.');
}

/**
 * 把一份报表追加到本机的「周报汇总文件」末尾。
 *
 * 追加形态对齐用户自己的 周报.md（最后几条就是长这样）：
 *
 *   #### 2026.09.14-2026.09.18 - 小组
 *
 *   ```
 *   本周完成：
 *   【项目】…
 *   ```
 *
 * .txt 用纯文本版（没有 # 和代码围栏）。正文一行都不改 —— 报表写的是什么就落什么。
 */
function reportAppendFile(state, today, payload) {
  const report = reportById(state, payload.id ?? payload.reportId ?? payload.report ?? payload.title);
  if (!report) return { ok: false, error: '找不到这份报表' };

  const configured = state.settings.reportFiles || [];
  const target = String(payload.path ?? payload.file ?? '').trim() || configured[0] || '';
  if (!target) return { ok: false, error: '还没有配置周报文件 —— 先到「设置」里加一个 .md 或 .txt 的绝对路径' };
  if (!path.isAbsolute(target)) return { ok: false, error: `周报文件必须是绝对路径：${target}` };
  const ext = path.extname(target).toLowerCase();
  if (ext !== '.md' && ext !== '.txt') return { ok: false, error: '周报文件只能是 .md 或 .txt' };
  if (!fs.existsSync(path.dirname(target))) return { ok: false, error: `目录不存在：${path.dirname(target)}` };

  const range = `${dotDate(report.from)}-${dotDate(report.to)}`;
  const signature = String(state.settings.reportSignature ?? '').trim();
  const content = String(report.content ?? '').replace(/\s+$/, '');
  if (!content) return { ok: false, error: '这份报表还没有正文，先生成或写点内容' };

  const block =
    ext === '.md'
      ? [signature ? `#### ${range} - ${signature}` : `#### ${range}`, '', '```', content, '```', '', ''].join('\n')
      : [signature ? `${range}-${signature}` : range, content, '', ''].join('\n');

  // 插到**最前面一条之前**（不是文首）—— 这样文件开头若有标题块不会被冲散，
  // 最新的周报也总是排在最上面。
  let existing = '';
  try {
    if (fs.existsSync(target)) existing = fs.readFileSync(target, 'utf8');
  } catch (error) {
    return { ok: false, error: `读不了 ${target}：${error.message}` };
  }

  const anchor = firstEntryIndex(existing);
  const next = anchor < 0 ? block + existing : existing.slice(0, anchor) + block + existing.slice(anchor);

  try {
    fs.writeFileSync(target, next, 'utf8');
  } catch (error) {
    return { ok: false, error: `写不进 ${target}：${error.message}` };
  }

  const bytes = Buffer.byteLength(block, 'utf8');
  return {
    ok: true,
    message: `📎 已插到 ${path.basename(target)} 开头：${range}`,
    result: { path: target, range, bytes, file: path.basename(target), atTop: anchor >= 0 },
  };
}

function reportSetStatus(state, payload, status) {
  const report = reportById(state, payload.id ?? payload.reportId);
  if (!report) return { ok: false, error: '找不到这份报表' };
  if (status === REPORT_STATUS.ARCHIVED) {
    if (report.status === REPORT_STATUS.ARCHIVED) return { ok: true, message: `《${report.title}》已经归档了`, result: { id: report.id } };
    report.status = REPORT_STATUS.ARCHIVED;
    report.archivedAt = nowIso();
    report.updatedAt = nowIso();
    return { ok: true, message: `🗄 已归档《${report.title}》（内容冻结，不可再改）`, result: { id: report.id, report } };
  }
  if (report.status === REPORT_STATUS.ARCHIVED) return { ok: false, error: '已归档的报表不能改回草稿；请用「修订」' };
  report.status = REPORT_STATUS.FINAL;
  report.finalizedAt = nowIso();
  report.updatedAt = nowIso();
  return { ok: true, message: `已定稿《${report.title}》`, result: { id: report.id, report } };
}

function reportRevise(state, today, payload) {
  const report = reportById(state, payload.id ?? payload.reportId);
  if (!report) return { ok: false, error: '找不到这份报表' };
  const stamp = nowIso();
  const copy = {
    ...report,
    id: uid('rp'),
    revision: report.revision + 1,
    status: REPORT_STATUS.DRAFT,
    createdAt: stamp,
    updatedAt: stamp,
    finalizedAt: null,
    archivedAt: null,
    supersedes: report.id,
    facts: report.facts ? JSON.parse(JSON.stringify(report.facts)) : null,
  };
  state.reports.push(copy);
  return { ok: true, message: `已基于《${report.title}》生成修订草稿（v${copy.revision}）`, result: { id: copy.id, report: copy } };
}

function reportRerender(state, today, payload) {
  const report = reportById(state, payload.id ?? payload.reportId);
  if (!report) return { ok: false, error: '找不到这份报表' };
  if (report.status === REPORT_STATUS.ARCHIVED) return { ok: false, error: '已归档的报表不可重新渲染；请用「修订」' };
  if (!report.facts) {
    // 没有冻结快照时，按当前状态重算一份。
    const built = buildReport(state, { type: report.type, from: report.from, to: report.to, projectId: report.projectId });
    report.facts = built.facts;
  }
  report.content = renderReport(report.facts, state.settings);
  report.updatedAt = nowIso();
  return { ok: true, message: `已按当前模板重新渲染《${report.title}》`, result: { id: report.id, report } };
}

function reportDelete(state, today, payload) {
  const report = reportById(state, payload.id ?? payload.reportId);
  if (!report) return { ok: false, error: '找不到这份报表' };
  if (report.status === REPORT_STATUS.ARCHIVED) return { ok: false, error: '已归档的报表不可删除（这就是归档的意义）' };
  state.reports = state.reports.filter((item) => item.id !== report.id);
  return { ok: true, message: `已删除《${report.title}》`, result: { id: report.id } };
}

/** 一键归档所有区间已经结束的草稿。 */
function reportArchiveStale(state, today) {
  const stale = state.reports.filter((item) => item.status === REPORT_STATUS.DRAFT && compareKey(item.to, today) < 0);
  for (const report of stale) {
    report.status = REPORT_STATUS.ARCHIVED;
    report.archivedAt = nowIso();
    report.updatedAt = nowIso();
  }
  return {
    ok: true,
    message: stale.length > 0 ? `🗄 已归档 ${stale.length} 份过期草稿` : '没有需要归档的过期草稿',
    result: { count: stale.length, ids: stale.map((item) => item.id) },
  };
}

/* ------------------------------------------------------------------ *
 * 设置与维护
 * ------------------------------------------------------------------ */

function settingsUpdate(state, today, payload) {
  const patch = payload.settings && typeof payload.settings === 'object' ? payload.settings : payload;
  const next = { ...state.settings };
  const touched = [];
  const numeric = { dailyHours: [0.5, 24], gradeFactor: [0.1, 5] };
  for (const [key, [min, max]] of Object.entries(numeric)) {
    if (patch[key] !== undefined) {
      next[key] = clampNum(patch[key], min, max, next[key]);
      touched.push(key);
    }
  }
  if (patch.grade !== undefined) {
    next.grade = String(patch.grade).slice(0, 40);
    touched.push('grade');
  }
  if (patch.gradeLabel !== undefined) {
    next.gradeLabel = String(patch.gradeLabel).slice(0, 60);
    touched.push('gradeLabel');
  }
  if (patch.rolloverPolicy !== undefined) {
    if (!Object.values(ROLLOVER).includes(patch.rolloverPolicy)) return { ok: false, error: 'rolloverPolicy 只能是 always / backlog / never' };
    next.rolloverPolicy = patch.rolloverPolicy;
    touched.push('rolloverPolicy');
  }
  if (patch.recurringRollover !== undefined) {
    if (!Object.values(ROLLOVER).includes(patch.recurringRollover)) return { ok: false, error: 'recurringRollover 只能是 always / backlog / never' };
    next.recurringRollover = patch.recurringRollover;
    touched.push('recurringRollover');
  }
  if (patch.leaveDeductsGoal !== undefined) {
    next.leaveDeductsGoal = patch.leaveDeductsGoal === true;
    touched.push('leaveDeductsGoal');
  }
  if (patch.carryOverMonths !== undefined) {
    next.carryOverMonths = patch.carryOverMonths === true;
    touched.push('carryOverMonths');
  }
  if (patch.reportFiles !== undefined) {
    if (!Array.isArray(patch.reportFiles)) return { ok: false, error: 'reportFiles 必须是数组' };
    for (const item of patch.reportFiles) {
      if (typeof item !== 'string') return { ok: false, error: 'reportFiles 里只能放字符串路径' };
      const value = item.trim();
      if (!value) continue;
      if (!path.isAbsolute(value)) return { ok: false, error: `周报文件必须是绝对路径：${value}` };
      if (!/\.(md|txt)$/i.test(value)) return { ok: false, error: `周报文件只能是 .md 或 .txt：${value}` };
    }
    next.reportFiles = patch.reportFiles
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 20);
    touched.push('reportFiles');
  }
  if (patch.reportSignature !== undefined) {
    next.reportSignature = String(patch.reportSignature).slice(0, 40);
    touched.push('reportSignature');
  }
  if (patch.reportFooter !== undefined) {
    next.reportFooter = String(patch.reportFooter).slice(0, 500);
    touched.push('reportFooter');
  }
  if (patch.reportTemplate !== undefined) {
    next.reportTemplate = String(patch.reportTemplate).slice(0, 8000);
    touched.push('reportTemplate');
  }
  if (patch.holidayOverrides !== undefined && patch.holidayOverrides && typeof patch.holidayOverrides === 'object') {
    next.holidayOverrides = { ...next.holidayOverrides, ...patch.holidayOverrides };
    touched.push('holidayOverrides');
  }
  if (touched.length === 0) return { ok: false, error: '没有需要修改的设置项' };
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings, ...next, holidayOverrides: next.holidayOverrides ?? {} };
  return { ok: true, message: `已更新设置：${touched.join('、')}`, result: { settings: state.settings } };
}

function holidayOverride(state, payload, remove) {
  const date = isKey(payload.date) ? payload.date : null;
  if (!date) return { ok: false, error: '请给出合法的日期' };
  const overrides = { ...state.settings.holidayOverrides };
  if (remove) {
    delete overrides[date];
    state.settings.holidayOverrides = overrides;
    return { ok: true, message: `已取消 ${date} 的手工标记`, result: { date } };
  }
  const kind = payload.kind === 'holiday' || payload.kind === 'workday' ? payload.kind : null;
  if (!kind) return { ok: false, error: 'kind 只能是 holiday 或 workday' };
  overrides[date] = kind;
  state.settings.holidayOverrides = overrides;
  const natural = dayKind(date, {});
  return {
    ok: true,
    message: `已把 ${date} 手工标记为「${kind === 'holiday' ? '放假' : '上班'}」（原性质：${holidayNameOf(date, {}) || natural}）`,
    result: { date, kind },
  };
}

/* ------------------------------------------------------------------ *
 * 总入口
 * ------------------------------------------------------------------ */

/** 动作名 → 处理函数。 */
const HANDLERS = {
  todo_create: todoCreate,
  todo_update: todoUpdate,
  todo_delete: todoDelete,
  todo_complete: todoComplete,
  todo_undo: todoUndo,
  todo_drop: todoDrop,
  todo_restore: todoRestore,
  todo_reschedule: todoReschedule,
  project_create: projectCreate,
  project_update: projectUpdate,
  project_delete: projectDelete,
  hours_mark: hoursMark,
  log_note: logNote,
  log_remove: logRemove,
  report_create: reportCreate,
  report_save: reportSave,
  report_finalize: (state, today, payload) => reportSetStatus(state, payload, REPORT_STATUS.FINAL),
  report_archive: (state, today, payload) => reportSetStatus(state, payload, REPORT_STATUS.ARCHIVED),
  report_revise: reportRevise,
  report_rerender: reportRerender,
  report_delete: reportDelete,
  report_archive_stale: reportArchiveStale,
  report_append_file: reportAppendFile,
  ticket_add: ticketCreate,
  ticket_update: ticketUpdate,
  ticket_remove: ticketRemove,
  settings_update: settingsUpdate,
  holiday_override_set: (state, today, payload) => holidayOverride(state, payload, false),
  holiday_override_clear: (state, today, payload) => holidayOverride(state, payload, true),
};

/** 全部可用的写操作名。 */
export const ACTION_NAMES = Object.keys(HANDLERS);

/**
 * 执行一次写操作。
 * @param state 状态（就地修改；顺延补算已由调用方完成）
 * @param today 今天的 day key
 * @param action 动作名
 * @param payload 参数
 */
export function applyAction(state, today, action, payload = {}) {
  const handler = HANDLERS[action];
  if (!handler) return { ok: false, error: `未知操作「${action}」` };
  try {
    return handler(state, today, payload);
  } catch (error) {
    console.warn(`[ai-workbench] 操作 ${action} 失败：${error?.stack ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 今天是否法定工作日（给工具与面板复用）。 */
export function todayIsWorkday(state, today) {
  return isWorkday(today, state.settings.holidayOverrides);
}

/** 当前月份的键。 */
export function currentMonth(today) {
  return monthKeyOf(today);
}
