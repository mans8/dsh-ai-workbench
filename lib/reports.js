/**
 * AI 工作台账 — 报表：结构化事实聚合 + Markdown 渲染。
 *
 * 两阶段设计（这是整个报表模块的关键）：
 *   ① 汇总（确定性）：同区间永远产出同样的 facts，可复算、可审计；
 *   ② 叙述（生成性）：草稿交给 Agent 或人润色后写回 content。
 *
 * 报表只从事实层（logs）取数，绝不从计划层倒推，
 * 所以「没做的事不会出现在周报里」。facts 在生成时冻结进报表记录，
 * 之后补录流水也不会回溯污染已经归档的历史报表。
 */
import { REPORT_STATUS, TODO_STATUS, logsInRange, projectById, reportById } from './state.js';
import {
  addMonths,
  clampInt,
  compareKey,
  isKey,
  isKeyInRange,
  monthKeyOf,
  monthLabel,
  isoWeekInfo,
  monthRange,
  daySpan,
  dayKeyOf,
  nowIso,
  pct,
  shiftKey,
  weekdayOf,
  yearKeyOf,
  yearRange,
} from './util.js';

/** 报表类型 → 区间单位的中文名。 */
const PERIOD_WORD = {
  weekly: '本周',
  monthly: '本月',
  yearly: '本年',
  project: '本期',
};

/** 报表类型 → 标题前缀。 */
const TITLE_PREFIX = {
  weekly: '周报',
  monthly: '月报',
  yearly: '年报',
  project: '项目报告',
};

/* ------------------------------------------------------------------ *
 * 区间解析
 * ------------------------------------------------------------------ */

/** 周报覆盖的天数：周一到周五。 */
export const REPORT_WEEK_DAYS = 5;

/**
 * 解析报表区间。
 * @param state 状态
 * @param opts { type, date, from, to, projectId, today }
 * @returns {{ type, dimension, projectId, from, to, label, week, year }}
 */
export function resolveReportRange(state, opts = {}) {
  const today = opts.today ?? dayKeyOf(); // 与全项目一致：本地时区的 YYYY-MM-DD
  const type = ['weekly', 'monthly', 'yearly', 'project'].includes(opts.type) ? opts.type : 'weekly';
  const projectId = opts.projectId || null;
  const explicitFrom = isKey(opts.from) ? opts.from : null;
  const explicitTo = isKey(opts.to) ? opts.to : null;

  // 自定义区间优先。
  if (explicitFrom && explicitTo) {
    const from = compareKey(explicitFrom, explicitTo) <= 0 ? explicitFrom : explicitTo;
    const to = compareKey(explicitFrom, explicitTo) <= 0 ? explicitTo : explicitFrom;
    return {
      type,
      dimension: type === 'project' ? 'project' : 'time',
      projectId,
      from,
      to,
      label: `${from.slice(5)} ~ ${to.slice(5)}`,
      week: null,
      year: Number(yearKeyOf(from)),
    };
  }

  const base = isKey(opts.date) ? opts.date : today;

  if (type === 'yearly') {
    const year = isKey(opts.date) ? Number(yearKeyOf(base)) : Number(yearKeyOf(today));
    const range = yearRange(year);
    return { type, dimension: 'time', projectId, from: range.from, to: range.to, label: `${year} 年`, week: null, year };
  }

  if (type === 'monthly') {
    const ym = monthKeyOf(base);
    const range = monthRange(ym);
    return { type, dimension: 'time', projectId, from: range.from, to: range.to, label: monthLabel(ym), week: null, year: Number(ym.slice(0, 4)) };
  }

  if (type === 'project') {
    // 项目维度：默认看本月，也可用 from/to 指定；项目存在则退化为项目生命周期。
    const project = projectById(state, projectId);
    const ym = monthKeyOf(base);
    const range = monthRange(ym);
    const from = project?.startedAt && compareKey(project.startedAt, range.from) < 0 ? project.startedAt : range.from;
    return { type, dimension: 'project', projectId, from, to: range.to, label: monthLabel(ym), week: null, year: Number(ym.slice(0, 4)) };
  }

  // 周报默认覆盖「本周一到本周五」。周中打开也能看到本周后半段的计划，
  // 生成时以流水为准，未来日期没有记录就不会出现在正文里。
  const from = shiftKey(base, -((weekdayOf(base) + 6) % 7)); // 本周一
  const to = shiftKey(from, REPORT_WEEK_DAYS - 1); // 本周五
  const info = isoWeekInfo(from);
  const week = { from, to, week: info.week, year: info.year };
  return {
    type: 'weekly',
    dimension: 'time',
    projectId,
    from: week.from,
    to: week.to,
    label: `${week.year} 年第 ${week.week} 周（${week.from.slice(5)} ~ ${week.to.slice(5)}）`,
    week: { year: week.year, week: week.week },
    year: week.year,
  };
}

/** 下一个区间（周报/月报/年报的「下期计划」用）。 */
function nextRangeOf(range) {
  if (range.type === 'weekly') {
    // 周报按自然周滚动：下一期就是下周同一天到周五。
    const from = shiftKey(range.from, 7);
    const to = shiftKey(range.to, 7);
    // 自定义区间就不再套「第 N 周」，直接给日期
    if (daySpan(range.from, range.to) !== REPORT_WEEK_DAYS) {
      return { from, to, label: `${from.slice(5)} ~ ${to.slice(5)}` };
    }
    const info = isoWeekInfo(from);
    return { from, to, label: `${info.year} 年第 ${info.week} 周（${from.slice(5)} ~ ${to.slice(5)}）` };
  }
  if (range.type === 'monthly') {
    const range2 = monthRange(addMonths(monthKeyOf(range.from), 1));
    return { ...range2, label: monthLabel(monthKeyOf(range2.from)) };
  }
  if (range.type === 'yearly') {
    const year = Number(yearKeyOf(range.from)) + 1;
    return { ...yearRange(year), label: `${year} 年` };
  }
  return null;
}

/** 上一个区间。 */
function prevRangeOf(range) {
  if (range.type === 'weekly') {
    return { from: shiftKey(range.from, -7), to: shiftKey(range.to, -7) };
  }
  if (range.type === 'monthly') {
    return monthRange(addMonths(monthKeyOf(range.from), -1));
  }
  if (range.type === 'yearly') {
    return yearRange(Number(yearKeyOf(range.from)) - 1);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 事实聚合
 * ------------------------------------------------------------------ */

/**
 * 生成报表事实快照。
 * @returns 结构化 facts（可直接 JSON 序列化后冻结进报表记录）
 */
export function buildReportFacts(state, range, options = {}) {
  const { from, to, projectId } = range;
  const logs = logsInRange(state, from, to, projectId)
    .slice()
    .sort((a, b) => compareKey(a.date, b.date) || compareKey(a.at, b.at));

  const allTodos = state.todos.filter((todo) => !todo.isTemplate);
  const todoById = new Map(allTodos.map((todo) => [todo.id, todo]));

  /**
   * 报表里的「事项信息」一律以**待办当前的值**为准，只有待办已经找不到了才退回流水快照。
   *
   * 流水里的 title / projectId 是完成那一刻写死的，改过标题或换过项目之后，
   * 报表还读流水就会显示成旧名字、落在旧项目组里 —— 真机上就是这么暴露的。
   * 报表本身仍然只收「真实发生过的事」（有没有这条流水），只是把它长什么样交给待办。
   */
  const liveOf = (log) => (log.todoId ? todoById.get(log.todoId) ?? null : null);
  const liveTitle = (log) => liveOf(log)?.title ?? log.title;
  const liveProjectId = (log) => {
    const live = liveOf(log);
    return live ? live.projectId : log.projectId;
  };
  const liveNote = (log) => {
    const live = liveOf(log);
    return (live && live.note) || log.note;
  };

  const scoped = projectId ? allTodos.filter((todo) => todo.projectId === projectId) : allTodos;

  // 完成明细
  const completed = logs.map((log) => {
    const pid = liveProjectId(log);
    return {
      id: log.id,
      date: log.date,
      title: liveTitle(log),
      note: liveNote(log),
      projectId: pid,
      projectName: projectById(state, pid)?.name ?? null,
      rolloverCount: log.rolloverCount,
      source: log.source,
    };
  });

  // 「本期未完成」= 在区间结束前就进入计划、但到区间结束时仍未了结的待办。
  // 判断依据是完成/放弃/漏做的时间戳，而不是它今天的状态 —— 这样补生成的
  // **历史**报表才不会被「后来终于做完了」这件事篡改。
  const carriedOver = scoped
    .filter((todo) => {
      if (todo.archived) return false;
      if (!todo.firstPlannedDate || compareKey(todo.firstPlannedDate, to) > 0) return false;
      if (todo.completedDate && compareKey(todo.completedDate, to) <= 0) return false;
      if (todo.droppedAt && compareKey(String(todo.droppedAt).slice(0, 10), to) <= 0) return false;
      if (todo.missedDate && compareKey(todo.missedDate, to) <= 0) return false;
      return true;
    })
    .map((todo) => ({
      id: todo.id,
      title: todo.title,
      projectName: projectById(state, todo.projectId)?.name ?? null,
      projectId: todo.projectId,
      rolloverCount: todo.rolloverCount,
      plannedDate: todo.plannedDate,
    }))
    .sort((a, b) => b.rolloverCount - a.rolloverCount);

  const dropped = scoped
    .filter(
      (todo) =>
        todo.status === TODO_STATUS.DROPPED &&
        todo.dropReason !== 'missed' &&
        todo.droppedAt &&
        isKeyInRange(String(todo.droppedAt).slice(0, 10), from, to),
    )
    .map((todo) => ({
      id: todo.id,
      title: todo.title,
      projectName: projectById(state, todo.projectId)?.name ?? null,
      reason: todo.dropReason,
      droppedAt: todo.droppedAt,
    }));

  const missed = scoped
    .filter((todo) => todo.missedDate && isKeyInRange(todo.missedDate, from, to))
    .map((todo) => ({ id: todo.id, title: todo.title, date: todo.missedDate }));

  const created = scoped.filter(
    (todo) => todo.createdAt && isKeyInRange(String(todo.createdAt).slice(0, 10), from, to),
  ).length;

  // ── 周报口径的汇报条目：项目分组 + 每条一个完成度 ──
  // 收录两类：① 区间内完成/记录过的事（来自流水）；② 区间内计划过但仍未了结的事（进行中）。
  // 汇报口径的完成度：做完了就是 100%；没做完用自己填的进度，没填就按 30%。
  const progressOf = (todo) =>
    todo.status === TODO_STATUS.DONE ? 100 : clampInt(todo.progress, 0, 100, 0) || 30;
  // 创建顺序：直接取它在 state.todos 里的下标。不用 createdAt 是因为同一毫秒批量创建会打平，
  // 打平之后就只能按标题排，读起来就不是你写进去的顺序了。
  const seqOfTodo = new Map(allTodos.map((todo, index) => [todo.id, index]));
  const seqOfLog = new Map(state.logs.map((log, index) => [log.id, index]));
  const weeklySeen = new Map();
  const proposed = new Set();
  const nextWeek = [];
  for (const log of logs) {
    const key = log.todoId ?? `log:${log.id}`;
    if (weeklySeen.has(key)) continue;
    const todo = log.todoId ? todoById.get(log.todoId) : null;
    weeklySeen.set(key, {
      todoId: todo?.id ?? null,
      // 改过标题 / 换过项目之后，周报要跟着变，所以取当前待办的值
      title: liveTitle(log),
      // 随手记没有进度概念，它记录的是「已经发生的事」，所以算 100%
      progress: todo ? progressOf(todo) : 100,
      projectId: liveProjectId(log),
      // 组内顺序按「创建先后」，也就是你写进待办列表的顺序 —— 汇报时最自然
      seq: todo ? seqOfTodo.get(todo.id) : 1e6 + (seqOfLog.get(log.id) ?? 0),
    });
  }
  for (const todo of scoped) {
    if (weeklySeen.has(todo.id) || todo.archived) continue;
    if (todo.status === TODO_STATUS.DROPPED) continue;
    if (!todo.plannedDate || !isKeyInRange(todo.plannedDate, from, to)) continue;
    if (todo.completedDate && compareKey(todo.completedDate, from) < 0) continue; // 更早就完成了，不属于本周
    weeklySeen.set(todo.id, {
      todoId: todo.id,
      title: todo.title,
      progress: progressOf(todo),
      projectId: todo.projectId,
      seq: seqOfTodo.get(todo.id) ?? 0,
    });
  }

  const weeklyByProject = new Map();
  for (const item of weeklySeen.values()) {
    const key = item.projectId ?? '__none__';
    if (!weeklyByProject.has(key)) weeklyByProject.set(key, []);
    weeklyByProject.get(key).push(item);
  }
  const weeklyGroups = [...weeklyByProject.entries()]
    .map(([key, items]) => {
      const project = key === '__none__' ? null : projectById(state, key);
      return {
        projectId: project?.id ?? null,
        name: project?.name ?? '未归类',
        items: items
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map((item) => ({ title: item.title, progress: item.progress })),
      };
    })
    .sort((a, b) => {
      // 项目按名称排（读起来像目录）；「未归类」永远垫底
      if (a.projectId === null) return 1;
      if (b.projectId === null) return -1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });

  // ── 下周待办 = 本周没收尾的 + 计划日落在下一周的 ──
  const pushProposal = (todo) => {
    if (!todo || proposed.has(todo.id)) return;
    if (todo.isTemplate || todo.archived || todo.status === TODO_STATUS.DROPPED) return;
    if (todo.status === TODO_STATUS.DONE) return;
    proposed.add(todo.id);
    const project = projectById(state, todo.projectId);
    nextWeek.push({
      todoId: todo.id,
      title: todo.title,
      projectId: todo.projectId,
      projectName: project?.name ?? null,
      // 用原标题：很多标题本身就带客户名（「村镇银行生产定时短信…」），
      // 再拼一次项目名会变成「示例银行-村镇银行村镇银行生产定时短信…」这种病句。
      label: todo.title,
      seq: seqOfTodo.get(todo.id) ?? 0,
    });
  };
  for (const item of weeklySeen.values()) {
    if (item.todoId && item.progress < 100) pushProposal(todoById.get(item.todoId));
  }
  // 「下周待办」只看下一个工作周（周一~周五）。
  const nextFrom = shiftKey(to, ((8 - weekdayOf(to)) % 7) || 7);
  const nextTo = shiftKey(nextFrom, REPORT_WEEK_DAYS - 1);
  for (const todo of scoped) {
    if (todo.plannedDate && isKeyInRange(todo.plannedDate, nextFrom, nextTo)) pushProposal(todo);
  }
  nextWeek.sort((a, b) => a.seq - b.seq);

  const planned = completed.length + missed.length + dropped.length;

  // 按项目分组（用于「本周完成」的分节）
  const groups = new Map();
  for (const item of completed) {
    const key = item.projectId ?? '__none__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const projectRows = [];
  for (const [key, items] of groups.entries()) {
    const project = key === '__none__' ? null : projectById(state, key);
    projectRows.push({
      projectId: project?.id ?? null,
      name: project?.name ?? '非项目事务',
      emoji: project?.emoji ?? '🗂',
      color: project?.color ?? '#8a94a6',
      done: items.length,
      highlights: items.map((item) => (item.note ? `${item.title} —— ${item.note}` : item.title)),
    });
  }
  projectRows.sort((a, b) => b.done - a.done);

  // 下期计划
  const next = nextRangeOf(range);
  const nextPlanned = next
    ? scoped
        .filter(
          (todo) =>
            todo.status === TODO_STATUS.OPEN &&
            (!todo.plannedDate || compareKey(todo.plannedDate, next.to) <= 0),
        )
        .map((todo) => ({
          id: todo.id,
          title: todo.title,
          projectName: projectById(state, todo.projectId)?.name ?? null,
          plannedDate: todo.plannedDate,
          priority: todo.priority,
          rolloverCount: todo.rolloverCount,
        }))
        .sort((a, b) => compareKey(a.plannedDate ?? '9999-99-99', b.plannedDate ?? '9999-99-99'))
        .slice(0, 20)
    : [];

  const prev = prevRangeOf(range);
  const prevLogs = prev ? logsInRange(state, prev.from, prev.to, projectId) : [];

  const project = projectId ? projectById(state, projectId) : null;

  return {
    meta: {
      type: range.type,
      dimension: range.dimension,
      projectId,
      projectName: project?.name ?? null,
      project,
      from,
      to,
      label: range.label,
      generatedAt: nowIso(),
      generatedBy: options.generatedBy ?? 'ai-workbench',
    },
    totals: {
      done: completed.length,
      created,
      dropped: dropped.length,
      missed: missed.length,
      planned,
      completionRate: pct(completed.length, planned),
      carryOverOpen: carriedOver.length,
      prevDone: prevLogs.length,
      deltaDone: completed.length - prevLogs.length,
    },
    byProject: projectRows,
    weeklyGroups,
    nextWeek,
    completed,
    carriedOver,
    dropped,
    missed,
    next: next ? { ...next, planned: nextPlanned } : null,
    previous: prev ? { ...prev, done: prevLogs.length } : null,
    range,
  };
}

/* ------------------------------------------------------------------ *
 * Markdown 渲染
 * ------------------------------------------------------------------ */

/** 项目分节渲染。 */
function renderProjectSections(facts) {
  if (facts.byProject.length === 0) return ['（本区间没有完成记录）'];
  const lines = [];
  for (const group of facts.byProject) {
    lines.push(`### ${group.emoji} ${group.name}（${group.done} 项）`);
    const items = facts.completed.filter((item) => (item.projectId ?? '__none__') === (group.projectId ?? '__none__'));
    for (const item of items) {
      lines.push(`- ${item.title}`);
      if (item.note) lines.push(`  > ${item.note.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 内置模板渲染。 */
/**
 * 周报的内置精简模板（可在设置里用自定义模板覆盖）：
 *
 *   本周完成：
 *   【项目名】
 *   1.事项一（30%）
 *   2.事项二（100%）
 *   【另一个项目】
 *   1.事项三（100%）
 *   下周待办：
 *   1.项目名事项四
 *   2.项目名事项五
 *
 * 规则：做完的件记 100%，没做完的记自己填的进度（没填就按 30%）；
 * 没做完的**同时**进入「下周待办」。没有标题、没有汇总数字，
 * 项目段之间也不空行 —— 整份东西只有一个目的：能直接贴进邮件。
 */
function renderWeeklyCompact(facts) {
  const lines = ['本周完成：'];
  const groups = facts.weeklyGroups || [];
  if (groups.length === 0) {
    lines.push('（本周没有可汇报的事项）');
  } else {
    for (const group of groups) {
      lines.push(`【${group.name}】`);
      group.items.forEach((item, index) => {
        lines.push(`${index + 1}.${item.title}（${clampInt(item.progress, 0, 100, 0)}%）`);
      });
    }
  }

  lines.push('下周待办：');
  const next = facts.nextWeek || [];
  next.forEach((item, index) => {
    lines.push(`${index + 1}.${item.label}`);
  });
  // 没有未了结的事时，「下周待办：」留空给手填
  return lines.join('\n').trimEnd();
}

function renderBuiltin(facts, settings) {
  // 没配自定义模板时，周报走精简口径；月报 / 年报 / 项目维度用完整叙述格式。
  if (facts.meta.type === 'weekly') return renderWeeklyCompact(facts);

  const word = PERIOD_WORD[facts.meta.type] ?? '本期';
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  let no = 0;
  /** 自增章节号，避免手工编号错位。 */
  const sec = (text) => `## ${CN[no++] ?? String(no)}、${text}`;
  const isProject = facts.meta.dimension === 'project' && facts.meta.project;
  const lines = [`# ${reportTitle(facts)}`, ''];

  if (isProject) {
    const p = facts.meta.project;
    lines.push(sec('项目概况'), '');
    lines.push(`- 项目：${p.emoji} ${p.name}${p.code ? `（${p.code}）` : ''}`);
    if (p.owner) lines.push(`- 负责人：${p.owner}`);
    if (p.startedAt) lines.push(`- 周期：${p.startedAt}${p.endedAt ? ` ~ ${p.endedAt}` : ' ~ 至今'}`);
    lines.push(`- 区间内完成 **${facts.totals.done}** 项`);
    lines.push(`- 进行中 ${facts.carriedOver.length} 项，已放弃 ${facts.totals.dropped} 项，漏做 ${facts.totals.missed} 项`);
    if (p.description) lines.push(`- 说明：${p.description}`);
    lines.push('');
  }

  lines.push(sec(`${word}完成（${facts.totals.done} 项）`), '');
  lines.push(...renderProjectSections(facts));
  lines.push('');

  lines.push(sec(`未完成（${facts.carriedOver.length} 项）`), '');
  if (facts.carriedOver.length === 0) {
    lines.push('- 无');
  } else {
    for (const item of facts.carriedOver.slice(0, 15)) {
      lines.push(`- ${item.projectName ? `[${item.projectName}] ` : ''}${item.title}`);
    }
  }
  lines.push('');

  if (facts.totals.dropped > 0 || facts.totals.missed > 0) {
    lines.push(sec('已放弃 / 漏做'), '');
    for (const item of facts.dropped) {
      lines.push(`- ✖️ ${item.projectName ? `[${item.projectName}] ` : ''}${item.title}（${item.reason || '未说明原因'}）`);
    }
    for (const item of facts.missed) {
      lines.push(`- ⏭️ ${item.title}（${item.date} 漏做）`);
    }
    lines.push('');
  }

  if (facts.totals.prevDone > 0) {
    lines.push(sec('完成环比'), '');
    const arrow = facts.totals.deltaDone >= 0 ? '↑' : '↓';
    lines.push(`- 完成数环比：${arrow} ${Math.abs(facts.totals.deltaDone)} 项（上期 ${facts.totals.prevDone} 项）`);
    lines.push('');
  }

  if (facts.next) {
    lines.push(sec(`下期计划（${facts.next.from} ~ ${facts.next.to}）`), '');
    if (facts.next.planned.length === 0) {
      lines.push('- （暂无计划，可从待办中挑选）');
    } else {
      for (const item of facts.next.planned) {
        lines.push(`- ${item.projectName ? `[${item.projectName}] ` : ''}${item.title}`);
      }
    }
    lines.push('');
  }

  lines.push(sec('风险与需要支持'), '');
  lines.push('- （待补充）');

  if (settings.reportFooter) {
    lines.push('', '---', '', settings.reportFooter);
  }
  return lines.join('\n');
}

/** 自定义模板：把 {{token}} 替换成对应的 Markdown 块。 */
function renderCustom(facts, template, settings) {
  const word = PERIOD_WORD[facts.meta.type] ?? '本期';
  const blocks = {
    title: reportTitle(facts),
    range: `${facts.meta.from} ~ ${facts.meta.to}`,
    label: facts.meta.label ?? '',
    project: facts.meta.projectName ?? '',
    completed: renderProjectSections(facts).join('\n'),
    byProject: facts.byProject.map((group) => `- ${group.emoji} ${group.name}：${group.done} 项`).join('\n'),
    // 周报专用块：让自定义模板也能渲染「本周完成 / 下周待办」的精简口径。
    weeklyCompleted: (facts.weeklyGroups || [])
      .map((group) => `【${group.name}】\n${group.items.map((item, index) => `${index + 1}.${item.title}（${clampInt(item.progress, 0, 100, 0)}%）`).join('\n')}`)
      .join('\n'),
    nextWeek: (facts.nextWeek || []).map((item, index) => `${index + 1}.${item.label}`).join('\n'),
    carriedOver:
      facts.carriedOver.length === 0
        ? '- 无'
        : facts.carriedOver.map((item) => `- ${item.projectName ? `[${item.projectName}] ` : ''}${item.title}`).join('\n'),
    dropped:
      facts.dropped.length === 0
        ? '- 无'
        : facts.dropped.map((item) => `- ${item.title}（${item.reason || '未说明原因'}）`).join('\n'),
    // 兼容旧模板里遗留的 {{hours}} 占位符：该口径已移除，这里渲染为空。
    hours: '',
    next: facts.next
      ? facts.next.planned.map((item) => `- ${item.projectName ? `[${item.projectName}] ` : ''}${item.title}`).join('\n') || '- （暂无计划）'
      : '- 无',
    stats: [
      `- ${word}完成 ${facts.totals.done} 项，放弃 ${facts.totals.dropped} 项，漏做 ${facts.totals.missed} 项`,
      `- 完成率 ${facts.totals.completionRate}%`,
    ].join('\n'),
    footer: settings.reportFooter ?? '',
  };
  return String(template).replace(/\{\{(\w+)\}\}/g, (match, name) => (name in blocks ? blocks[name] : match));
}

/** 报表标题。 */
export function reportTitle(facts) {
  const prefix = TITLE_PREFIX[facts.meta.type] ?? '报告';
  if (facts.meta.dimension === 'project') {
    const name = facts.meta.projectName ?? '未指定项目';
    return `${prefix} · ${name}（${facts.meta.from} ~ ${facts.meta.to}）`;
  }
  if (facts.meta.type === 'weekly' && facts.range?.week) {
    return `${prefix} · ${facts.range.week.year} W${String(facts.range.week.week).padStart(2, '0')}（${facts.meta.from.slice(5)} ~ ${facts.meta.to.slice(5)}）`;
  }
  return `${prefix} · ${facts.meta.label}`;
}

/** 渲染报表正文。 */
export function renderReport(facts, settings) {
  const template = typeof settings?.reportTemplate === 'string' ? settings.reportTemplate.trim() : '';
  return template ? renderCustom(facts, template, settings) : renderBuiltin(facts, settings);
}

/**
 * 一步生成报表草稿（facts + 标题 + 正文）。
 * 这是 Agent 工具 workbench_report 的 `draft` 与面板「生成」按钮共用的唯一入口。
 */
export function buildReport(state, opts = {}) {
  const range = resolveReportRange(state, opts);
  const facts = buildReportFacts(state, range, { generatedBy: opts.generatedBy });
  return {
    range,
    facts,
    title: reportTitle({ ...facts, range }),
    content: renderReport({ ...facts, range }, state.settings),
  };
}

/** 报表状态中文名。 */
export function reportStatusLabel(status) {
  if (status === REPORT_STATUS.ARCHIVED) return '已归档';
  if (status === REPORT_STATUS.FINAL) return '已定稿';
  return '草稿';
}

/** 已归档的报表不可编辑。 */
export function isEditable(report) {
  return !!report && report.status !== REPORT_STATUS.ARCHIVED;
}

/** 读取一份报表（供 tools 用）。 */
export function getReport(state, id) {
  return reportById(state, id);
}
