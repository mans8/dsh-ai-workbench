/**
 * AI 工作台账 — 派生视图。
 *
 * 本文件只做「读」：把 state 变成面板与 Agent 需要的形状，绝不修改 state。
 * 所有口径（完成率、按时率等）在这里一次性算准，
 * Client 只负责画，不再自己算数 —— 避免面板和 Agent 报出两个不一样的结果。
 */
import { dayKind, holidayInfo, holidayNameOf, isWorkday } from './calendar.js';
import { REPORT_STATUS, TODO_STATUS, activeLogs, logsInRange, projectById } from './state.js';
import {
  addMonths,
  clampInt,
  compareKey,
  dayKeyOf,
  eachDay,
  isKey,
  isKeyInRange,
  isoWeekInfo,
  monthKeyOf,
  monthRange,
  pct,
  shiftKey,
  shortLabel,
  weekdayLabel,
  weekdayOf,
  weekRange,
  yearKeyOf,
  yearRange,
} from './util.js';

/** 月度趋势默认回看月数。 */
const TREND_MONTHS = 6;
/** 统计桶数量上限。 */
const MAX_BUCKETS = 800;
/** 热力图最多回看天数。 */
const MAX_HEATMAP_DAYS = 400;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 重复规则的人类可读描述。 */
function repeatLabel(repeat) {
  if (!repeat) return '';
  switch (repeat.freq) {
    case 'daily':
      return '每天';
    case 'workdays':
      return '每个法定工作日';
    case 'weekdays':
      return '周一至周五';
    case 'weekly': {
      const names = ['日', '一', '二', '三', '四', '五', '六'];
      const list = (repeat.weekdays ?? []).map((w) => `周${names[w]}`);
      return list.length > 0 ? `每${list.join('、')}` : '每周';
    }
    case 'monthly': {
      const list = (repeat.monthDays ?? []).map((d) => `${d} 号`);
      return list.length > 0 ? `每月 ${list.join('、')}` : '每月';
    }
    default:
      return '';
  }
}

/** 待办的展示增强。 */
export function enrichTodo(state, todo, today) {
  const project = projectById(state, todo.projectId);
  const overdue = !!todo.dueDate && compareKey(todo.dueDate, today) < 0 && todo.status === TODO_STATUS.OPEN;
  const overdueDays = overdue ? eachDay(todo.dueDate, shiftKey(today, -1)).length : 0;
  return {
    id: todo.id,
    title: todo.title,
    note: todo.note,
    projectId: todo.projectId,
    projectName: project?.name ?? null,
    projectEmoji: project?.emoji ?? null,
    projectColor: project?.color ?? null,
    priority: todo.priority,
    tags: todo.tags,
    kind: todo.kind,
    isTemplate: todo.isTemplate,
    templateId: todo.templateId,
    repeat: todo.repeat,
    repeatLabel: todo.isTemplate ? repeatLabel(todo.repeat) : '',
    plannedDate: todo.plannedDate,
    plannedLabel: todo.plannedDate ? shortLabel(todo.plannedDate) : '',
    firstPlannedDate: todo.firstPlannedDate,
    dueDate: todo.dueDate,
    progress: todo.status === TODO_STATUS.DONE ? 100 : clampInt(todo.progress, 0, 100, 0),
    rollover: todo.rollover,
    status: todo.status,
    archived: todo.archived,
    backlog: todo.backlog,
    rolloverCount: todo.rolloverCount,
    carried: todo.rolloverCount > 0 && !todo.isTemplate,
    carriedLabel: todo.rolloverCount > 0 ? `顺延 ${todo.rolloverCount} 天` : '',
    carriedLevel: todo.rolloverCount >= 7 ? 'high' : todo.rolloverCount >= 3 ? 'mid' : todo.rolloverCount > 0 ? 'low' : 'none',
    overdue,
    overdueDays,
    completedDate: todo.completedDate,
    completedAt: todo.completedAt,
    droppedAt: todo.droppedAt,
    dropReason: todo.dropReason,
    missedDate: todo.missedDate,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
  };
}

/** 只统计「真正在流转」的待办（排除模板）。 */
function liveTodos(state) {
  return state.todos.filter((todo) => !todo.archived && !todo.isTemplate);
}

/* ------------------------------------------------------------------ *
 * 今日
 * ------------------------------------------------------------------ */

/** 「历史完成」一次最多带多少条，够翻就行，不必全量。 */
const HISTORY_LIMIT = 60;

/** 今日视图。 */
export function todayView(state, today) {
  const overrides = state.settings.holidayOverrides;
  const kind = dayKind(today, overrides);
  const week = weekRange(today);
  const all = liveTodos(state).map((todo) => enrichTodo(state, todo, today));

  const open = all.filter((todo) => todo.status === TODO_STATUS.OPEN);
  const planToday = open.filter((todo) => todo.plannedDate === today && !todo.backlog);
  const backlog = open.filter((todo) => todo.backlog === true || (todo.plannedDate && compareKey(todo.plannedDate, today) < 0));
  const future = open.filter((todo) => todo.plannedDate && compareKey(todo.plannedDate, today) > 0);
  const overdue = open.filter((todo) => todo.overdue);
  const doneToday = all.filter((todo) => todo.completedDate === today);
  // 「本周完成」= 本周（周一~周日）完成的所有事，不只是今天。
  const weekDone = all
    .filter((todo) => todo.completedDate && isKeyInRange(todo.completedDate, week.from, week.to))
    .sort((a, b) => compareKey(b.completedDate, a.completedDate) || compareKey(b.completedAt ?? '', a.completedAt ?? ''));
  // 「历史完成」= 本周之前完成的。只给最近一批，页面不展开就是一句话的事。
  const doneBefore = all
    .filter((todo) => todo.completedDate && compareKey(todo.completedDate, week.from) < 0)
    .sort((a, b) => compareKey(b.completedDate, a.completedDate) || compareKey(b.completedAt ?? '', a.completedAt ?? ''));
  const historyDone = doneBefore.slice(0, HISTORY_LIMIT);
  const droppedToday = all.filter((todo) => todo.droppedAt && String(todo.droppedAt).slice(0, 10) === today);

  const carriedIn = planToday.filter((todo) => todo.carried);

  const warnings = [];
  if (overdue.length > 0) {
    warnings.push({ level: 'danger', text: `${overdue.length} 项已逾期` });
  }

  return {
    date: today,
    weekday: weekdayLabel(today),
    dateLabel: shortLabel(today),
    kind,
    workday: isWorkday(today, overrides),
    holidayName: holidayNameOf(today, overrides),
    week,
    weekLabel: `${week.year} 年第 ${week.week} 周`,
    stats: {
      openCount: open.length,
      plannedCount: planToday.length,
      doneCount: doneToday.length,
      weekDoneCount: weekDone.length,
      historyDoneCount: doneBefore.length,
      carriedCount: carriedIn.length,
      backlogCount: backlog.length,
      futureCount: future.length,
      overdueCount: overdue.length,
      progress: pct(doneToday.length, doneToday.length + planToday.length),
    },
    todos: planToday,
    backlog,
    overdue,
    done: doneToday,
    weekDone,
    historyDone,
    historyTotal: doneBefore.length,
    dropped: droppedToday,
    carriedIn,
    logs: activeLogs(state)
      .filter((log) => log.date === today)
      .sort((a, b) => compareKey(b.at, a.at)),
    projects: state.projects.filter((item) => item.status === 'active'),
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 待办列表
 * ------------------------------------------------------------------ */

/** 待办列表（含筛选）。 */
export function todosView(state, options = {}) {
  const today = options.today ?? dayKeyOf();
  const q = String(options.q ?? '').trim().toLowerCase();
  const from = isKey(options.from) ? options.from : null;
  const to = isKey(options.to) ? options.to : null;

  let rows = state.todos.slice();
  if (options.includeTemplates !== true) rows = rows.filter((todo) => !todo.isTemplate);
  if (options.archived !== true) rows = rows.filter((todo) => !todo.archived);
  if (options.projectId) rows = rows.filter((todo) => todo.projectId === options.projectId);
  if (options.status && options.status !== 'all') rows = rows.filter((todo) => todo.status === options.status);
  if (options.backlog === true) rows = rows.filter((todo) => todo.backlog === true);
  if (options.tag) rows = rows.filter((todo) => todo.tags.includes(options.tag));
  if (from) rows = rows.filter((todo) => todo.plannedDate && compareKey(todo.plannedDate, from) >= 0);
  if (to) rows = rows.filter((todo) => todo.plannedDate && compareKey(todo.plannedDate, to) <= 0);
  if (q) {
    rows = rows.filter(
      (todo) =>
        todo.title.toLowerCase().includes(q) ||
        todo.note.toLowerCase().includes(q) ||
        todo.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }

  const enriched = rows.map((todo) => enrichTodo(state, todo, today));
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  enriched.sort((a, b) => {
    if (a.status !== b.status) {
      const order = { open: 0, done: 1, dropped: 2 };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    }
    if ((a.plannedDate ?? '') !== (b.plannedDate ?? '')) {
      return compareKey(a.plannedDate ?? '9999-99-99', b.plannedDate ?? '9999-99-99');
    }
    return (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9);
  });

  return {
    total: enriched.length,
    counts: {
      open: enriched.filter((item) => item.status === TODO_STATUS.OPEN).length,
      done: enriched.filter((item) => item.status === TODO_STATUS.DONE).length,
      dropped: enriched.filter((item) => item.status === TODO_STATUS.DROPPED).length,
      carried: enriched.filter((item) => item.carried && item.status === TODO_STATUS.OPEN).length,
    },
    tags: Array.from(new Set(state.todos.flatMap((todo) => todo.tags))).sort(),
    todos: enriched.slice(0, 500),
  };
}

/* ------------------------------------------------------------------ *
 * 项目
 * ------------------------------------------------------------------ */

/** 项目视图：每个项目带上区间内的完成数与最近活动。 */
export function projectsView(state, options = {}) {
  const today = options.today ?? dayKeyOf();

  return state.projects
    .slice()
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return compareKey(a.createdAt, b.createdAt);
    })
    .map((project) => {
      const todos = state.todos.filter((todo) => todo.projectId === project.id && !todo.isTemplate);
      const open = todos.filter((todo) => todo.status === TODO_STATUS.OPEN && !todo.archived);
      const done = todos.filter((todo) => todo.status === TODO_STATUS.DONE);
      const logs = activeLogs(state).filter((log) => log.projectId === project.id);
      const lastActivity = logs.map((log) => log.date).sort().pop() ?? null;
      return {
        ...project,
        openCount: open.length,
        doneCount: done.length,
        totalCount: todos.length,
        progress: pct(done.length, todos.length),
        carriedCount: open.filter((todo) => todo.rolloverCount > 0).length,
        overdueCount: open.filter((todo) => todo.dueDate && compareKey(todo.dueDate, today) < 0).length,
        lastActivity,
        nextTodos: open
          .slice()
          .sort((a, b) => compareKey(a.plannedDate ?? '9999-99-99', b.plannedDate ?? '9999-99-99'))
          .slice(0, 5)
          .map((todo) => enrichTodo(state, todo, today)),
      };
    });
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

/** 按维度枚举统计桶。 */
function enumerateBuckets(dim, from, to) {
  const out = [];
  if (dim === 'year') {
    const startYear = Number(yearKeyOf(from));
    const endYear = Number(yearKeyOf(to));
    for (let y = startYear; y <= endYear && out.length < MAX_BUCKETS; y += 1) {
      out.push({ key: String(y), from: `${y}-01-01`, to: `${y}-12-31`, label: `${y} 年` });
    }
    return out;
  }
  if (dim === 'month') {
    let cursor = monthKeyOf(from);
    const last = monthKeyOf(to);
    while (compareKey(cursor, last) <= 0 && out.length < MAX_BUCKETS) {
      const range = monthRange(cursor);
      out.push({ key: cursor, from: range.from, to: range.to, label: `${Number(cursor.slice(5))} 月` });
      cursor = addMonths(cursor, 1);
    }
    return out;
  }
  for (const key of eachDay(from, to).slice(0, MAX_BUCKETS)) {
    out.push({ key, from: key, to: key, label: shortLabel(key) });
  }
  return out;
}

/** 单个桶内的统计。 */
function bucketStats(state, bucket, projectId) {
  const logs = logsInRange(state, bucket.from, bucket.to, projectId).filter((log) => !log.voided);
  const days = eachDay(bucket.from, bucket.to);
  const done = logs.length;
  const onTime = logs.filter((log) => log.rolloverCount === 0).length;
  const rolledOut = days.reduce((sum, key) => sum + (state.rolloverLog[key] ?? 0), 0);
  const missed = state.todos.filter((todo) => todo.missedDate && isKeyInRange(todo.missedDate, bucket.from, bucket.to)).length;
  const droppedList = state.todos.filter(
    (todo) =>
      todo.status === TODO_STATUS.DROPPED &&
      todo.dropReason !== 'missed' &&
      todo.droppedAt &&
      isKeyInRange(String(todo.droppedAt).slice(0, 10), bucket.from, bucket.to) &&
      (!projectId || todo.projectId === projectId),
  );
  const dropped = droppedList.length;
  const created = state.todos.filter(
    (todo) =>
      !todo.isTemplate &&
      isKeyInRange(String(todo.createdAt).slice(0, 10), bucket.from, bucket.to) &&
      (!projectId || todo.projectId === projectId),
  ).length;
  const planned = done + rolledOut + missed + dropped;
  return {
    key: bucket.key,
    label: bucket.label,
    from: bucket.from,
    to: bucket.to,
    done,
    created,
    dropped,
    missed,
    rolledOut,
    planned,
    completionRate: pct(done, planned),
    onTime,
    onTimeRate: pct(onTime, done),
  };
}

/** 日/月/年统计。 */
export function statsView(state, options = {}) {
  const today = options.today ?? dayKeyOf();
  const dim = ['day', 'month', 'year'].includes(options.dim) ? options.dim : 'month';
  let from = isKey(options.from) ? options.from : shiftKey(today, -29);
  let to = isKey(options.to) ? options.to : today;
  if (compareKey(from, to) > 0) {
    const swap = from;
    from = to;
    to = swap;
  }
  const projectId = options.projectId || null;
  const buckets = enumerateBuckets(dim, from, to).map((bucket) => bucketStats(state, bucket, projectId));

  const total = buckets.reduce(
    (acc, item) => ({
      done: acc.done + item.done,
      created: acc.created + item.created,
      dropped: acc.dropped + item.dropped,
      missed: acc.missed + item.missed,
      rolledOut: acc.rolledOut + item.rolledOut,
      planned: acc.planned + item.planned,
      onTime: acc.onTime + item.onTime,
    }),
    { done: 0, created: 0, dropped: 0, missed: 0, rolledOut: 0, onTime: 0, planned: 0 },
  );
  total.completionRate = pct(total.done, total.planned);
  total.onTimeRate = pct(total.onTime, total.done);

  return {
    dim,
    from,
    to,
    projectId,
    buckets,
    totals: total,
    heatmap: dim === 'year' || options.heatmap === true ? heatmapOf(state, from, to) : null,
  };
}

/** 热力图：每天的完成数。 */
export function heatmapOf(state, from, to) {
  const days = eachDay(from, to).slice(-MAX_HEATMAP_DAYS);
  const counts = new Map();
  for (const log of activeLogs(state)) counts.set(log.date, (counts.get(log.date) ?? 0) + 1);
  const peak = Math.max(1, ...Array.from(counts.values()));
  return days.map((key) => {
    const count = counts.get(key) ?? 0;
    return {
      date: key,
      weekday: weekdayOf(key),
      count,
      level: count === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((count / peak) * 4))),
    };
  });
}

/* ------------------------------------------------------------------ *
 * 报表（列表与详情；内容生成在 reports.js）
 * ------------------------------------------------------------------ */

/** 报表列表。 */
export function reportsView(state, options = {}) {
  const q = String(options.q ?? '').trim().toLowerCase();
  let rows = state.reports.slice();
  if (options.type) rows = rows.filter((item) => item.type === options.type);
  if (options.dimension) rows = rows.filter((item) => item.dimension === options.dimension);
  if (options.projectId) rows = rows.filter((item) => item.projectId === options.projectId);
  if (options.status && options.status !== 'all') rows = rows.filter((item) => item.status === options.status);
  if (isKey(options.from)) rows = rows.filter((item) => compareKey(item.to, options.from) >= 0);
  if (isKey(options.to)) rows = rows.filter((item) => compareKey(item.from, options.to) <= 0);
  if (q) rows = rows.filter((item) => item.title.toLowerCase().includes(q) || item.content.toLowerCase().includes(q));

  rows.sort((a, b) => compareKey(b.from, a.from) || compareKey(b.createdAt, a.createdAt));
  const slim = rows.map((item) => ({
    id: item.id,
    type: item.type,
    dimension: item.dimension,
    projectId: item.projectId,
    projectName: projectById(state, item.projectId)?.name ?? null,
    from: item.from,
    to: item.to,
    title: item.title,
    status: item.status,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    finalizedAt: item.finalizedAt,
    archivedAt: item.archivedAt,
    supersedes: item.supersedes,
    excerpt: String(item.content).replace(/^#.*$/m, '').trim().slice(0, 120),
    totals: item.facts?.totals ?? null,
  }));

  return {
    total: slim.length,
    counts: {
      draft: state.reports.filter((item) => item.status === REPORT_STATUS.DRAFT).length,
      final: state.reports.filter((item) => item.status === REPORT_STATUS.FINAL).length,
      archived: state.reports.filter((item) => item.status === REPORT_STATUS.ARCHIVED).length,
    },
    projects: state.projects.map((item) => ({ id: item.id, name: item.name, emoji: item.emoji })),
    reports: slim,
  };
}

/** 单份报表。 */
export function reportView(state, id) {
  const report = state.reports.find((item) => item.id === id);
  if (!report) return null;
  return {
    ...report,
    projectName: projectById(state, report.projectId)?.name ?? null,
    editable: report.status !== REPORT_STATUS.ARCHIVED,
  };
}

/* ------------------------------------------------------------------ *
 * 快照（面板启动用）
 * ------------------------------------------------------------------ */

/** 面板启动所需的轻量快照。 */
export function bootstrapView(state, today) {
  const open = liveTodos(state).filter((todo) => todo.status === TODO_STATUS.OPEN);
  return {
    today,
    settings: {
      rolloverPolicy: state.settings.rolloverPolicy,
      recurringRollover: state.settings.recurringRollover,
      holidayOverrides: state.settings.holidayOverrides,
      reportFooter: state.settings.reportFooter,
      reportFiles: state.settings.reportFiles,
      reportSignature: state.settings.reportSignature,
      reportTemplate: state.settings.reportTemplate,
    },
    cursor: { ...state.cursor },
    counts: {
      projects: state.projects.filter((item) => item.status !== 'archived').length,
      openTodos: open.length,
      templates: state.todos.filter((todo) => todo.isTemplate && todo.status === TODO_STATUS.OPEN).length,
      carried: open.filter((todo) => todo.rolloverCount > 0).length,
      reports: state.reports.length,
      draftReports: state.reports.filter((item) => item.status === REPORT_STATUS.DRAFT).length,
      logs: activeLogs(state).length,
    },
    holiday: holidayInfo(),
    projects: state.projects
      .filter((item) => item.status !== 'archived')
      .map((item) => ({ id: item.id, name: item.name, emoji: item.emoji, color: item.color })),
  };
}

/** 默认统计用的日期区间（供 Client 的快捷按钮用）。 */
export function defaultRanges(today) {
  const week = weekRange(today);
  const month = monthRange(monthKeyOf(today));
  const year = yearRange(yearKeyOf(today));
  return {
    today,
    week,
    month,
    year,
    lastWeek: weekRange(shiftKey(week.from, -7)),
    lastMonth: monthRange(addMonths(monthKeyOf(today), -1)),
    lastYear: yearRange(Number(yearKeyOf(today)) - 1),
    weekInfo: isoWeekInfo(today),
  };
}
