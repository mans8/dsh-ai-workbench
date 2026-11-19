/**
 * AI 工作台账 — 派生视图。
 *
 * 本文件只做「读」：把 state 变成面板与 Agent 需要的形状，绝不修改 state。
 * 所有口径（完成率、达成率、缺口、日需工时）在这里一次性算准，
 * Client 只负责画，不再自己算数 —— 避免面板和 Agent 报出两个不一样的结果。
 */
import {
  coverageOf,
  dayKind,
  holidayInfo,
  holidayNameOf,
  isWorkday,
  monthGrid,
  monthProgress,
  workdaysInMonth,
} from './calendar.js';
import {
  DAY_STATUS,
  REPORT_STATUS,
  TODO_STATUS,
  activeLogs,
  dayHoursOf,
  logsInRange,
  projectById,
} from './state.js';
import {
  addMonths,
  clampInt,
  compareKey,
  dayKeyOf,
  eachDay,
  fmtHours,
  isKey,
  isKeyInRange,
  isoWeekInfo,
  monthKeyOf,
  monthLabel,
  monthRange,
  pct,
  round2,
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
    estimateHours: todo.estimateHours,
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

  const record = state.days[today] ?? null;
  const logged = dayHoursOf(state, today);
  const target = isWorkday(today, overrides) ? state.settings.dailyHours : 0;

  const carriedIn = planToday.filter((todo) => todo.carried);

  // ── 本月工时摘要 ──────────────────────────────────────────────
  // 工时是月底按派发单独填的台账，和待办是两回事，所以这里只给「月度视角」，
  // 不做「今天还没记工时」这种每日催促 —— 那会把两套东西又绑回去。
  const month = monthKeyOf(today);
  const progress = monthProgress(month, today, overrides);
  const planHours = round2(progress.total * state.settings.dailyHours);
  const requiredHours = round2(planHours * state.settings.gradeFactor);
  const monthLogged = round2(sumHours(state, progress.from, progress.to, null));
  const monthGap = round2(Math.max(0, requiredHours - monthLogged));
  const monthNeedPerDay = progress.remaining > 0 ? round2(monthGap / progress.remaining) : null;

  const warnings = [];
  if (overdue.length > 0) {
    warnings.push({ level: 'danger', text: `${overdue.length} 项已逾期` });
  }
  // 月底提醒：剩余法定工作日不多而工时还差，就提示去补工单。
  if (monthGap > 0 && progress.remaining > 0 && progress.remaining <= 5) {
    warnings.push({
      level: 'warn',
      text: `本月工时还差 ${fmtHours(monthGap)}（剩余 ${progress.remaining} 个法定工作日），记得补工单`,
    });
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
    month: {
      month,
      label: monthLabel(month),
      from: progress.from,
      to: progress.to,
      workdays: progress.total,
      planHours,
      requiredHours,
      loggedHours: monthLogged,
      achievement: pct(monthLogged, requiredHours),
      gapHours: monthGap,
      remainingWorkdays: progress.remaining,
      needPerDay: monthNeedPerDay,
      needPerDayOver: monthNeedPerDay !== null && monthNeedPerDay > state.settings.dailyHours,
    },
    hours: {
      logged: round2(logged),
      target,
      progress: target > 0 ? pct(logged, target) : 0,
      status: record?.status ?? DAY_STATUS.NORMAL,
      note: record?.note ?? '',
      entries: (record?.entries ?? []).map((entry) => ({
        ...entry,
        projectName: projectById(state, entry.projectId)?.name ?? null,
        projectEmoji: projectById(state, entry.projectId)?.emoji ?? null,
      })),
      manualHours: record?.manualHours ?? null,
    },
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

/** 项目视图：每个项目带上区间内的完成数与工时。 */
export function projectsView(state, options = {}) {
  const today = options.today ?? dayKeyOf();

  // 项目「投入工时」只能来自工时台账（state.days 里的条目），不能读流水的 hours ——
  // 那个字段从「两套台账解耦」之后恒为 0，读它就会永远是「投入 0h」。
  const hoursByProjectId = new Map();
  const lastWorkedByProjectId = new Map();
  for (const [dateKey, record] of Object.entries(state.days)) {
    if (record.manualHours !== null && record.manualHours !== undefined) {
      // 历史数据里可能还有「整天填报」的残留，它没有项目归属，只能记到「未归类」
      hoursByProjectId.set('__none__', round2((hoursByProjectId.get('__none__') ?? 0) + record.manualHours));
    }
    for (const entry of record.entries) {
      const key = entry.projectId ?? '__none__';
      hoursByProjectId.set(key, round2((hoursByProjectId.get(key) ?? 0) + (Number(entry.hours) || 0)));
      if (entry.projectId) {
        const prev = lastWorkedByProjectId.get(entry.projectId);
        if (!prev || compareKey(dateKey, prev) > 0) lastWorkedByProjectId.set(entry.projectId, dateKey);
      }
    }
  }

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
      const worked = hoursByProjectId.get(project.id) ?? 0;
      // 最近活动：完成过的流水日期，和真正记过工时的日期，取更晚的那个
      const logLatest = logs.map((log) => log.date).sort().pop() ?? null;
      const workedLatest = lastWorkedByProjectId.get(project.id) ?? null;
      const lastActivity = !logLatest ? workedLatest : !workedLatest ? logLatest : compareKey(logLatest, workedLatest) >= 0 ? logLatest : workedLatest;
      return {
        ...project,
        openCount: open.length,
        doneCount: done.length,
        totalCount: todos.length,
        progress: pct(done.length, todos.length),
        hours: worked,
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
 * 工时
 * ------------------------------------------------------------------ */

/** 单个区间（通常是一个月）的工时总览。 */
export function hoursSummary(state, month, today) {
  const overrides = state.settings.holidayOverrides;
  const settings = state.settings;
  const progress = monthProgress(month, today, overrides);
  const planHours = round2(progress.total * settings.dailyHours);
  const requiredHours = round2(planHours * settings.gradeFactor);

  const grid = monthGrid(month, today, overrides).map((cell) => {
    const record = state.days[cell.key] ?? null;
    const logged = dayHoursOf(state, cell.key);
    return {
      ...cell,
      hours: round2(logged),
      status: record?.status ?? DAY_STATUS.NORMAL,
      note: record?.note ?? '',
      entries: record?.entries?.length ?? 0,
      met: cell.workday && logged >= settings.dailyHours,
      partial: logged > 0 && (!cell.workday || logged < settings.dailyHours),
    };
  });

  const loggedHours = round2(sumHours(state, progress.from, progress.to, null));

  // 请假天数（半天记 0.5）。
  let leaveDays = 0;
  let overtimeHours = 0;
  for (const cell of grid) {
    if (cell.status === DAY_STATUS.LEAVE) leaveDays += 1;
    else if (cell.status === DAY_STATUS.HALF_LEAVE) leaveDays += 0.5;
    if (cell.hours <= 0) continue;
    if (cell.workday) overtimeHours += Math.max(0, cell.hours - settings.dailyHours);
    else overtimeHours += cell.hours;
  }
  leaveDays = round2(leaveDays);
  overtimeHours = round2(overtimeHours);

  const elapsedIdeal = round2(progress.elapsed * settings.dailyHours * settings.gradeFactor);
  const gapHours = round2(Math.max(0, requiredHours - loggedHours));
  const remaining = progress.remaining;
  const needPerDay = remaining > 0 ? round2(gapHours / remaining) : null;
  const coverage = coverageOf(progress.from, progress.to);
  const tickets = ticketsInRange(state, progress.from, progress.to);

  return {
    month,
    label: monthLabel(month),
    from: progress.from,
    to: progress.to,
    dailyHours: settings.dailyHours,
    gradeFactor: settings.gradeFactor,
    gradeLabel: settings.gradeLabel,
    workdays: progress.total,
    elapsedWorkdays: progress.elapsed,
    remainingWorkdays: remaining,
    planHours,
    requiredHours,
    loggedHours,
    achievement: pct(loggedHours, requiredHours),
    gapHours,
    idealHours: elapsedIdeal,
    paceDelta: round2(loggedHours - elapsedIdeal),
    needPerDay,
    needPerDayOver: needPerDay !== null && needPerDay > settings.dailyHours,
    leaveDays,
    overtimeHours,
    settled: remaining === 0,
    isFutureMonth: compareKey(progress.from, today) > 0,
    coverage,
    days: grid,
    byProject: hoursByProject(state, progress.from, progress.to),
    tickets,
    ticketHours: round2(tickets.reduce((sum, item) => sum + (item.hours || 0), 0)),
    trend: hoursTrend(state, month, today, TREND_MONTHS),
  };
}

/** 区间内的工单（按日期、再按录入先后排）。 */
export function ticketsInRange(state, from, to) {
  return (state.tickets || [])
    .filter((ticket) => ticket.date && isKeyInRange(ticket.date, from, to))
    .slice()
    .sort((a, b) => compareKey(a.date, b.date) || compareKey(a.createdAt ?? '', b.createdAt ?? ''))
    .map((ticket) => {
      const project = projectById(state, ticket.projectId);
      return {
        id: ticket.id,
        date: ticket.date,
        projectId: ticket.projectId,
        projectName: project?.name ?? null,
        projectEmoji: project?.emoji ?? null,
        projectColor: project?.color ?? null,
        url: ticket.url || '',
        type: ticket.type || '',
        title: ticket.title,
        hours: ticket.hours,
        note: ticket.note || '',
        createdAt: ticket.createdAt,
      };
    });
}

/** 区间内按项目聚合工时。 */
export function hoursByProject(state, from, to) {
  const map = new Map();
  const bump = (projectId, hours) => {
    const key = projectId ?? '__none__';
    map.set(key, round2((map.get(key) ?? 0) + hours));
  };
  for (const [key, record] of Object.entries(state.days)) {
    if (compareKey(key, from) < 0 || compareKey(key, to) > 0) continue;
    if (record.manualHours !== null && record.manualHours !== undefined) {
      bump(null, record.manualHours);
      continue;
    }
    for (const entry of record.entries) bump(entry.projectId, Number(entry.hours) || 0);
  }
  const rows = [];
  for (const [id, hours] of map.entries()) {
    const project = id === '__none__' ? null : projectById(state, id);
    if (!project && id !== '__none__') {
      rows.push({ projectId: id, name: '已删除项目', emoji: '🗑', color: '#8a94a6', hours });
      continue;
    }
    if (!project) {
      rows.push({ projectId: null, name: '未归类', emoji: '🗂', color: '#8a94a6', hours });
      continue;
    }
    rows.push({ projectId: project.id, name: project.name, emoji: project.emoji, color: project.color, hours });
  }
  return rows.sort((a, b) => b.hours - a.hours);
}

/** 区间内工时合计（可按项目过滤）。 */
export function sumHours(state, from, to, projectId) {
  let total = 0;
  for (const [key, record] of Object.entries(state.days)) {
    if (compareKey(key, from) < 0 || compareKey(key, to) > 0) continue;
    if (record.manualHours !== null && record.manualHours !== undefined) {
      if (!projectId) total += record.manualHours;
      continue;
    }
    for (const entry of record.entries) {
      if (projectId && entry.projectId !== projectId) continue;
      total += Number(entry.hours) || 0;
    }
  }
  return round2(total);
}

/** 近 N 个月的达成率趋势。 */
export function hoursTrend(state, month, today, count = TREND_MONTHS) {
  const rows = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const ym = addMonths(month, -i);
    const range = monthRange(ym);
    if (!range) continue;
    const total = workdaysInMonth(ym, state.settings.holidayOverrides);
    const plan = round2(total * state.settings.dailyHours);
    const required = round2(plan * state.settings.gradeFactor);
    const logged = sumHours(state, range.from, range.to, null);
    rows.push({
      month: ym,
      label: `${Number(ym.slice(5))}月`,
      workdays: total,
      planHours: plan,
      requiredHours: required,
      loggedHours: logged,
      achievement: pct(logged, required),
      isCurrent: ym === monthKeyOf(today),
    });
  }
  return rows;
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
  // 工时只来自工时台账（days），和「完成了哪些待办」是两回事。
  const hours = sumHours(state, bucket.from, bucket.to, projectId);
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
    hours,
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
      hours: acc.hours + item.hours,
    }),
    { done: 0, created: 0, dropped: 0, missed: 0, rolledOut: 0, onTime: 0, planned: 0, hours: 0 },
  );
  total.hours = round2(total.hours);
  total.completionRate = pct(total.done, total.planned);
  total.onTimeRate = pct(total.onTime, total.done);

  // 区间内的工时口径（来自 days，与 logs 计数相互独立）。
  const legs = {
    workdays: 0,
    planHours: 0,
    requiredHours: 0,
    loggedHours: sumHours(state, from, to, projectId),
  };
  for (const key of eachDay(from, to)) {
    if (isWorkday(key, state.settings.holidayOverrides)) legs.workdays += 1;
  }
  legs.planHours = round2(legs.workdays * state.settings.dailyHours);
  legs.requiredHours = round2(legs.planHours * state.settings.gradeFactor);
  legs.achievement = pct(legs.loggedHours, legs.requiredHours);

  return {
    dim,
    from,
    to,
    projectId,
    buckets,
    totals: total,
    legs,
    byProject: hoursByProject(state, from, to),
    heatmap: dim === 'year' || options.heatmap === true ? heatmapOf(state, from, to) : null,
  };
}

/** 热力图：每天的完成数与工时。 */
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
      hours: round2(dayHoursOf(state, key)),
      workday: isWorkday(key, state.settings.holidayOverrides),
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
  const month = monthKeyOf(today);
  const hours = hoursSummary(state, month, today);
  return {
    today,
    settings: {
      dailyHours: state.settings.dailyHours,
      grade: state.settings.grade,
      gradeLabel: state.settings.gradeLabel,
      gradeFactor: state.settings.gradeFactor,
      rolloverPolicy: state.settings.rolloverPolicy,
      recurringRollover: state.settings.recurringRollover,
      leaveDeductsGoal: state.settings.leaveDeductsGoal,
      carryOverMonths: state.settings.carryOverMonths,
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
    hours: {
      month,
      label: hours.label,
      workdays: hours.workdays,
      planHours: hours.planHours,
      requiredHours: hours.requiredHours,
      loggedHours: hours.loggedHours,
      achievement: hours.achievement,
      gapHours: hours.gapHours,
      needPerDay: hours.needPerDay,
      needPerDayOver: hours.needPerDayOver,
      coverage: hours.coverage,
    },
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
