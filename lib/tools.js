/**
 * AI 工作台账 — Agent 工具。
 *
 * 三个工具按域拆分（待办 / 工时 / 报表），而不是塞进一个巨型 action 枚举：
 * 每个工具的 schema 更短、意图边界更清晰，模型选错的概率显著更低。
 * 三个工具与浏览器面板共用同一套领域函数（domain.js / actions.js），
 * 所以「面板能做的，Agent 都能做」，反之亦然。
 */
import { applyAction } from './actions.js';
import {
  hoursSummary,
  projectsView,
  reportView,
  reportsView,
  statsView,
  todayView,
  todosView,
} from './domain.js';
import { REPORT_STATUS } from './state.js';
import { clampInt, fmtHours, monthKeyOf } from './util.js';

/** 统一的文本输出形状。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
};

/** 过滤掉空串后 join。 */
function lines(...parts) {
  return parts.flat().filter((item) => item !== null && item !== undefined && item !== '').join('\n');
}

/** 优先级徽标。 */
function prio(todo) {
  return `[${todo.priority}]`;
}

/** 待办单行渲染。 */
function todoLine(todo, index) {
  const bits = [];
  if (todo.projectName) bits.push(`${todo.projectEmoji ?? '📁'}${todo.projectName}`);
  if (todo.carried) bits.push(`顺延${todo.rolloverCount}天`);
  if (todo.estimateHours) bits.push(`预估${fmtHours(todo.estimateHours)}`);
  if (todo.dueDate) bits.push(`⏰${todo.dueDate}`);
  if (todo.tags.length > 0) bits.push(todo.tags.map((t) => `#${t}`).join(''));
  const prefix = index === undefined ? '-' : `${index + 1}.`;
  return `  ${prefix} ${prio(todo)} ${todo.title}${bits.length > 0 ? `  ${bits.join('  ')}` : ''}${
    todo.id ? `  \`${todo.id}\`` : ''
  }`;
}

/* ------------------------------------------------------------------ *
 * workbench_todo
 * ------------------------------------------------------------------ */

/** 待办工具。 */
export function todoTool(store) {
  return {
    name: 'workbench_todo',
    description:
      '查询与操作「AI 工作台账」的待办清单。核心机制：今天没完成的待办会自动顺延到明天（同一件事、同一条记录，只改计划日并累加顺延天数），所以永远不会丢事。待办可归属项目、带优先级（P0 紧急/P1 高/P2 中/P3 低，默认 P2）、预估工时（只是计划值）、硬截止日；带 repeat 的待办会变成「重复任务模板」并自动开出当天实例。**待办与工时是两套互不挂钩的台账**：完成/撤销待办不会产生或收回任何工时，记工时请用 workbench_hours 的 ticket_add（工单是工时的唯一来源）。action 取值：today（今日战报，默认从这里开始）、list（列表，可按 project/status/from/to/tag/q 过滤）、add（新建，repeat 传 {freq:"daily"|"workdays"|"weekdays"|"weekly"|"monthly", weekdays:[0-6], monthDays:[1-31]} 即成为重复任务）、update、remove、complete（完成任务，可带 note；不接受 hours）、undo（撤销完成，只作废事实流水）、drop（放弃，需 reason）、restore（恢复）、reschedule（改期：传 plannedDate 或 deltaDays，或 toToday/toBacklog）、rollover（手动推进顺延并报告积压情况）、project_add/project_update/project_remove/project_list（项目管理）。task 参数可传待办标题（支持部分匹配）或 id。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'today',
            'list',
            'add',
            'update',
            'remove',
            'complete',
            'undo',
            'drop',
            'restore',
            'reschedule',
            'rollover',
            'project_add',
            'project_update',
            'project_remove',
            'project_list',
          ],
          description: '要执行的操作。',
        },
        task: { type: 'string', description: '待办标题（支持部分匹配）或 id。' },
        title: { type: 'string', description: '待办标题（add/update），或随手记内容。' },
        note: { type: 'string', description: '备注（add/update/complete）。' },
        project: { type: 'string', description: '项目名、代号或 id（add/update/list 过滤）。' },
        priority: {
          type: 'string',
          enum: ['P0', 'P1', 'P2', 'P3'],
          description:
            '优先级，默认 P2。含义：P0 紧急=立刻做（线上故障、阻塞别人、当天必须交付）；P1 高=尽快做（本周要交付、别人在等）；P2 中=正常排期；P3 低=有空再做。',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '标签。' },
        plannedDate: { type: 'string', description: '计划执行日 YYYY-MM-DD。' },
        dueDate: { type: 'string', description: '硬截止日 YYYY-MM-DD（留空字符串可清除）。' },
        estimateHours: { type: 'number', description: '预估工时（小时）。' },
        progress: {
          type: 'number',
          description: '完成度 0~100，只用于汇报口径。周报草稿会写成「1.事项名（30%）」；做完的待办一律按 100% 呈现，不看这个字段。',
        },
        repeat: { type: 'object', description: '重复规则：{freq, weekdays?, monthDays?}；不传则是一次性待办。' },
        rollover: { type: 'string', enum: ['inherit', 'always', 'backlog', 'never'], description: '顺延策略：always 顺延（默认）、backlog 顺延进积压、never 到期作废。' },
        reason: { type: 'string', description: '放弃原因（drop）或项目说明。' },
        toToday: { type: 'boolean', description: 'reschedule：拉回今天。' },
        toBacklog: { type: 'boolean', description: 'reschedule：转入积压。' },
        deltaDays: { type: 'number', description: 'reschedule：相对当前计划日平移的天数。' },
        enabled: { type: 'boolean', description: 'update：启用/停用重复任务模板。' },
        emoji: { type: 'string', description: '项目图标（project_add/project_update）。' },
        code: { type: 'string', description: '项目代号（project_add/project_update）。' },
        status: { type: 'string', description: 'list：状态过滤 open/done/dropped/all；project_update：active/paused/archived。' },
        q: { type: 'string', description: 'list：关键词搜索标题与备注。' },
        tag: { type: 'string', description: 'list：按标签过滤。' },
        from: { type: 'string', description: 'list：计划日下界 YYYY-MM-DD。' },
        to: { type: 'string', description: 'list：计划日上界 YYYY-MM-DD。' },
        includeDone: { type: 'boolean', description: 'list：是否包含已完成的（默认包含）。' },
        limit: { type: 'number', description: 'list：最多返回多少条，默认 40。' },
        date: { type: 'string', description: 'target date，默认今天（today 视图用；报表用它定位所在周/月/年）。' },
        from: { type: 'string', description: 'report：自定义区间起点 YYYY-MM-DD（与 to 一起给时优先于 date）。' },
        to: { type: 'string', description: 'report：自定义区间终点 YYYY-MM-DD。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const action = String(args?.action ?? '');
      const { value } = await store.run(args?.date, (state, key, rollover) => {
        const rolloverNote = rolloverSummary(rollover);

        if (action === 'today') {
          const view = todayView(state, key);
          return lines(reportTodayText(view), rolloverNote);
        }

        if (action === 'list') {
          const view = todosView(state, {
            today: key,
            status: args?.status ?? 'all',
            q: args?.q,
            tag: args?.tag,
            from: args?.from,
            to: args?.to,
          });
          let rows = view.todos;
          if (args?.project) {
            const needle = String(args.project).toLowerCase();
            rows = rows.filter(
              (item) => item.projectName && item.projectName.toLowerCase().includes(needle),
            );
          }
          if (args?.includeDone === false) rows = rows.filter((item) => item.status === 'open');
          const limit = clampInt(args?.limit, 1, 200, 40);
          const shown = rows.slice(0, limit);
          return lines(
            `待办共 ${view.total} 条（进行中 ${view.counts.open} · 已完成 ${view.counts.done} · 已放弃 ${view.counts.dropped} · 顺延中 ${view.counts.carried}）${
              rows.length > shown.length ? `，只显示前 ${shown.length} 条` : ''
            }`,
            '',
            shown.length === 0 ? '  （没有匹配的待办）' : shown.map((item, i) => todoLine(item, i)).join('\n'),
          );
        }

        if (action === 'project_list') {
          const rows = projectsView(state, { today: key });
          if (rows.length === 0) return '还没有项目。用 action=project_add 建一个。';
          return lines(
            `共 ${rows.length} 个项目：`,
            '',
            rows.map((p) => `  ${p.emoji} ${p.name}${p.code ? `（${p.code}）` : ''} · ${p.status} · 进行中 ${p.openCount} / 已完成 ${p.doneCount} · ${fmtHours(p.hours)}`).join('\n'),
          );
        }

        if (action === 'rollover') {
          const view = todayView(state, key);
          return lines(
            `顺延游标：${state.cursor.rolledThrough}`,
            `今日待办 ${view.stats.plannedCount} 项，其中 ${view.stats.carriedCount} 项是从以前顺延过来的；积压 ${view.stats.backlogCount} 项。`,
            '',
            view.todos.length === 0 ? '今天没有待办。' : view.todos.map((item, i) => todoLine(item, i)).join('\n'),
          );
        }

        // 其余都是写操作：映射到 actions.js 的动作名。
        const mapped = {
          add: 'todo_create',
          update: 'todo_update',
          remove: 'todo_delete',
          complete: 'todo_complete',
          undo: 'todo_undo',
          drop: 'todo_drop',
          restore: 'todo_restore',
          reschedule: 'todo_reschedule',
          project_add: 'project_create',
          project_update: 'project_update',
          project_remove: 'project_delete',
        }[action];
        if (!mapped) return `未知操作「${action}」`;

        const payload = {
          id: args?.task,
          task: args?.task,
          title: args?.title,
          note: args?.note,
          name: args?.title,
          project: args?.project,
          projectId: args?.project,
          priority: args?.priority,
          tags: args?.tags,
          plannedDate: args?.plannedDate,
          dueDate: args?.dueDate,
          estimateHours: args?.estimateHours,
          progress: args?.progress,
          repeat: args?.repeat,
          rollover: args?.rollover,
          reason: args?.reason,
          toToday: args?.toToday,
          toBacklog: args?.toBacklog,
          deltaDays: args?.deltaDays,
          enabled: args?.enabled,
          emoji: args?.emoji,
          code: args?.code,
          status: args?.status,
          description: args?.reason,
        };

        const before = todayView(state, key);
        const result = applyAction(state, key, mapped, payload);
        if (!result.ok) return `❌ ${result.error}`;
        const after = todayView(state, key);
        const p = payload.projectId ?? payload.project;
        const projectArg = p ? state.projects.find((item) => item.id === p || item.name === p) : null;
        return lines(
          result.message,
          '',
          `今日：待办 ${after.stats.plannedCount} 项（顺延 ${after.stats.carriedCount}）· 完成 ${after.stats.doneCount} 项 · 积压 ${after.stats.backlogCount} 项`,
          projectArg ? `项目 ${projectArg.emoji}${projectArg.name}：进行中 ${after.todos.filter((t) => t.projectId === projectArg.id).length} 项` : '',
          before.stats.overdueCount !== after.stats.overdueCount ? `⚠️ 逾期项从 ${before.stats.overdueCount} 变为 ${after.stats.overdueCount}` : '',
          rolloverNote,
        );
      });
      return value;
    },
  };
}

/** 把顺延结果压成一行提示。 */
function rolloverSummary(rollover) {
  if (!rollover || !rollover.days) return '';
  const bits = [`已自动顺延 ${rollover.days} 天`];
  if (rollover.moved.length > 0) bits.push(`${rollover.moved.length} 项未完成被推进`);
  if (rollover.created.length > 0) bits.push(`开出 ${rollover.created.length} 条重复任务`);
  if (rollover.missed.length > 0) bits.push(`${rollover.missed.length} 项到期作废`);
  return `🔄 ${bits.join('，')}`;
}

/** 今日战报文本。 */
function reportTodayText(view) {
  const head = `📅 ${view.date} 周${view.weekday} · ${view.weekLabel} · ${kindLabel(view)}`;
  const chips = [
    `待办 ${view.stats.plannedCount} 项`,
    view.stats.carriedCount > 0 ? `其中顺延 ${view.stats.carriedCount} 项` : '',
    `今天完成 ${view.stats.doneCount} 项`,
    `本周完成 ${view.stats.weekDoneCount} 项`,
    view.stats.backlogCount > 0 ? `积压 ${view.stats.backlogCount} 项` : '',
    view.stats.overdueCount > 0 ? `🔴 逾期 ${view.stats.overdueCount} 项` : '',
  ].filter(Boolean);

  const sections = [head, chips.join(' · '), ''];

  sections.push('▸ 今日待办');
  sections.push(view.todos.length === 0 ? '  （清空了）' : view.todos.map((item, i) => todoLine(item, i)).join('\n'));
  sections.push('');

  if (view.done.length > 0) {
    sections.push('▸ 今日已完成');
    sections.push(view.done.map((item) => `  ✅ ${item.title}`).join('\n'));
    sections.push('');
  }

  if (view.backlog.length > 0) {
    sections.push(`▸ 积压 ${view.backlog.length} 项（未进今日列表）`);
    sections.push(view.backlog.slice(0, 10).map((item) => `  ${item.title}${item.carried ? `（顺延 ${item.rolloverCount} 天）` : ''}`).join('\n'));
    sections.push('');
  }

  if (view.overdue.length > 0) {
    sections.push('▸ 🔴 已逾期');
    sections.push(view.overdue.map((item) => `  ${item.title}（截止 ${item.dueDate}，逾期 ${item.overdueDays} 天）`).join('\n'));
    sections.push('');
  }

  if (view.hours.entries.length > 0) {
    sections.push('▸ 今日工时明细');
    sections.push(
      view.hours.entries
        .map((entry) => `  ${fmtHours(entry.hours)}  ${entry.projectEmoji ?? ''}${entry.projectName ?? '未归类'}  ${entry.note}`)
        .join('\n'),
    );
    sections.push('');
  }

  if (view.logs.length > 0) {
    sections.push('▸ 今日流水');
    sections.push(view.logs.map((log) => `  ${String(log.at).slice(11, 16)}  ${log.title}`).join('\n'));
  }

  // 工时是另一套台账（月底批量填），所以这里给月度视角，不按天唠叨。
  if (view.month) {
    sections.push('');
    sections.push('▸ 本月工时（与待办无关，来自工单）');
    sections.push(
      `  法定工作日 ${view.month.workdays} 天 · 计划 ${fmtHours(view.month.planHours)} · 必须 ${fmtHours(view.month.requiredHours)} · 已录 ${fmtHours(view.month.loggedHours)}（${view.month.achievement}%）`,
    );
    if (view.month.gapHours > 0) {
      sections.push(
        `  还差 ${fmtHours(view.month.gapHours)}，剩余 ${view.month.remainingWorkdays} 个法定工作日${
          view.month.needPerDay !== null ? `（日均需 ${fmtHours(view.month.needPerDay)}）` : ''
        }`,
      );
    }
  }

  return lines(...sections).trimEnd();
}

/** 日期性质的中文标签。 */
function kindLabel(view) {
  if (view.kind === 'holiday') return `法定节假日${view.holidayName ? `（${view.holidayName}）` : ''}`;
  if (view.kind === 'adjusted-workday') return `调休上班${view.holidayName ? `（${view.holidayName}）` : ''}`;
  if (view.kind === 'weekend') return '周末';
  return '法定工作日';
}

/* ------------------------------------------------------------------ *
 * workbench_hours
 * ------------------------------------------------------------------ */

/** 工时工具。 */
export function hoursTool(store) {
  return {
    name: 'workbench_hours',
    description:
      '查询与录入「AI 工作台账」的工时台账。**工时与待办完全无关**，而且**工时的唯一来源是工单**：要体现工时，就记一条带 hours 的工单，它会自动落进当月台账；已经没有「逐条记工时 / 整天填报 / 月底批量填报」这些入口了。口径固定按月：当月计划工时 = 该月中国法定工作日数 × 7.5 小时；当月必须工时 = 计划工时 × 职级系数（默认 1.1，可在设置里改）。法定工作日按国务院放假安排计算（含节假日与调休上班的周末），数据内置到 2026 年，未覆盖的年份会明确告警而不是猜。action 取值：month（月度总览：计划/必须/已录/达成率/缺口/剩余工作日/日需工时，默认从这里开始；含本月工单表）、calendar（月历）、day（某天明细，含当天各条工单）、mark（标记 leave/half-leave/overtime，只影响请假统计，不改小时数）、trend（近 N 个月达成率趋势）、ticket_add（**记一条工单**，也是记工时的唯一方式：title 必填，可带 url / hours / project / date / note；hours 留空表示「无工时」）、ticket_remove（删工单，连同它带的小时）。month 参数格式 YYYY-MM，默认当月。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['month', 'calendar', 'day', 'mark', 'trend', 'ticket_add', 'ticket_remove'],
          description: '要执行的操作。',
        },
        month: { type: 'string', description: '月份 YYYY-MM，默认当月。' },
        date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天。' },
        hours: { type: 'number', description: 'ticket_add：这条工单的小时数，0~300；留空表示「无工时」。' },
        project: { type: 'string', description: '项目名或 id（log 时归属该项目）。' },
        note: { type: 'string', description: 'ticket_add：备注，比如「不改」。' },
        title: { type: 'string', description: 'ticket_add：问题 / 任务标题。' },
        url: { type: 'string', description: 'ticket_add：工单链接（可留空）。' },
        type: { type: 'string', enum: ['售后', '工时派发', '新建项目'], description: 'ticket_add：工单类型。' },
        ticket: { type: 'string', description: 'ticket_remove：工单 id 或标题片段。' },
        status: { type: 'string', enum: ['normal', 'leave', 'half-leave', 'overtime'], description: '出勤标记（mark）。' },
        months: { type: 'number', description: '趋势回看的月数，默认 6，最大 24。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const action = String(args?.action ?? '');
      const { value } = await store.run(args?.date, async (state, key) => {
        const month = /^\d{4}-\d{2}$/.test(String(args?.month ?? '')) ? String(args.month) : monthKeyOf(key);

        if (action === 'month') {
          return reportHoursText(hoursSummary(state, month, key));
        }

        if (action === 'calendar') {
          const view = hoursSummary(state, month, key);
          return lines(reportHoursText(view), '', renderCalendarText(view));
        }

        if (action === 'day') {
          const date = String(args?.date ?? key);
          const cell = hoursSummary(state, monthKeyOf(date), key).days.find((item) => item.key === date);
          if (!cell) return `❌ 找不到日期 ${date}`;
          const record = state.days[date] ?? null;
          return lines(
            `${date} 周${'日一二三四五六'[cell.weekday]} · ${calKindLabel(cell)} · 已录 ${fmtHours(cell.hours)}${cell.status !== 'normal' ? ` · 标记 ${cell.status}` : ''}`,
            '',
            record && record.entries.length > 0
              ? record.entries.map((entry) => `  ${fmtHours(entry.hours)}  ${entry.note || '（无备注）'}`).join('\n')
              : record && record.manualHours !== null && record.manualHours !== undefined
                ? `  整天填报 ${fmtHours(record.manualHours)}`
                : '  （这一天还没有工时记录）',
          );
        }

        if (action === 'trend') {
          const count = clampInt(args?.months, 1, 24, 6);
          const view = hoursSummary(state, month, key);
          const rows = view.trend.slice(-count);
          return lines(
            `近 ${rows.length} 个月工时达成率：`,
            '',
            rows
              .map(
                (row) =>
                  `  ${row.month}  法定 ${String(row.workdays).padStart(2)} 天  必须 ${String(row.requiredHours).padStart(7)}h  已录 ${String(row.loggedHours).padStart(7)}h  达成 ${String(row.achievement).padStart(5)}%${row.isCurrent ? '  ← 本月' : ''}`,
              )
              .join('\n'),
          );
        }

        const mapped = {
          ticket_add: 'ticket_add',
          ticket_remove: 'ticket_remove',
          mark: 'hours_mark',
        }[action];
        if (!mapped) return `未知操作「${action}」`;

        const targetMonth = monthKeyOf(String(args?.date ?? key));
        // ticket_remove 允许只给标题片段：先在当前状态里找出唯一的那条
        let ticketId = args?.ticket;
        if (action === 'ticket_remove' && ticketId) {
          const hit = state.tickets.find((item) => item.id === ticketId) || state.tickets.find((item) => item.title.includes(String(ticketId)));
          if (!hit) return `❌ 找不到工单「${ticketId}」`;
          ticketId = hit.id;
        }
        const result = applyAction(state, key, mapped, {
          id: action === 'ticket_remove' ? ticketId : args?.id,
          date: args?.date,
          month,
          hours: args?.hours,
          project: args?.project,
          projectId: args?.project,
          note: args?.note,
          title: args?.title,
          url: args?.url,
          type: args?.type,
          status: args?.status,
        });
        if (!result.ok) return `❌ ${result.error}`;
        const view = hoursSummary(state, targetMonth, key);
        return lines(result.message, '', reportHoursText(view));
      });
      return value;
    },
  };
}

/** 月度工时文本。 */
function reportHoursText(view) {
  const rows = [
    `📊 工时 · ${view.label}（${view.from} ~ ${view.to}）`,
    `职级 ${view.gradeLabel}（系数 ${view.gradeFactor}）× 每日 ${fmtHours(view.dailyHours)}`,
    '',
    `  法定工作日   ${view.workdays} 天（已过 ${view.elapsedWorkdays}，剩余 ${view.remainingWorkdays}）`,
    `  计划工时     ${fmtHours(view.planHours)}`,
    `  必须工时     ${fmtHours(view.requiredHours)}   ← 计划 × ${view.gradeFactor}`,
    `  已录工时     ${fmtHours(view.loggedHours)}`,
    `  达成率       ${view.achievement}%`,
    `  缺口         ${fmtHours(view.gapHours)}`,
  ];
  if (view.needPerDay !== null) {
    rows.push(`  日需工时     ${fmtHours(view.needPerDay)}${view.needPerDayOver ? '  🔴 超过每天 7.5h，按正常节奏已补不回来' : '  ✅'}`);
  } else {
    rows.push('  日需工时     —（本月已结束）');
  }
  rows.push(`  进度节拍     ${view.paceDelta >= 0 ? '领先' : '落后'} ${fmtHours(Math.abs(view.paceDelta))}（理想 ${fmtHours(view.idealHours)}）`);
  if (view.leaveDays > 0) rows.push(`  请假         ${view.leaveDays} 天（法定硬口径，不扣减必须工时）`);
  if (view.overtimeHours > 0) rows.push(`  加班         ${fmtHours(view.overtimeHours)}`);
  if (!view.coverage.complete) {
    rows.push('');
    rows.push(`  ⚠️ ${view.coverage.uncoveredYears.join('、')} 年的节假日安排尚未导入，这些日期按「周一~周五 = 工作日」估算，工时数字可能不准。`);
  }
  if (view.byProject.length > 0) {
    rows.push('', '▸ 按项目分布');
    rows.push(view.byProject.map((item) => `  ${item.emoji} ${item.name}：${fmtHours(item.hours)}`).join('\n'));
  }
  // 工单表：工时的唯一来源，所以月报里必须能看到它
  rows.push('', `▸ 本月工单（${(view.tickets || []).length} 条，合计 ${fmtHours(view.ticketHours || 0)}）`);
  if ((view.tickets || []).length === 0) {
    rows.push('  （本月还没有工单 —— 工时只能由工单产生）');
  } else {
    for (const ticket of view.tickets) {
      const hours = ticket.hours === null || ticket.hours === undefined ? '无工时' : `${fmtHours(ticket.hours)}${ticket.note ? `（${ticket.note}）` : ''}`;
      rows.push(`  ${String(ticket.date).slice(5)}  ${ticket.projectName ?? '未归类'}  ${ticket.title}  ${hours}`);
      if (ticket.url) rows.push(`          ${ticket.url}`);
    }
  }
  return rows.join('\n');
}

/** 月历文本（周一为第一列）。 */
function renderCalendarText(view) {
  const cells = view.days;
  if (cells.length === 0) return '';
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  const out = [names.map((n) => n.padStart(4)).join('')];
  let week = new Array(7).fill('');
  for (const cell of cells) {
    const col = (cell.weekday + 6) % 7;
    week[col] = cellTag(cell);
    if (col === 6) {
      out.push(week.join(''));
      week = new Array(7).fill('');
    }
  }
  if (week.some((item) => item !== '')) out.push(week.join(''));
  out.push('', '图例：✓ 已达标  ◐ 部分  · 未录  假 法定节假日  调 调休上班  今 今天');
  return out.join('\n');
}

/** 月历单元格（定宽 4 字符）。 */
function cellTag(cell) {
  const mark = cell.isToday ? '今' : cell.holiday ? '假' : cell.kind === 'adjusted-workday' ? '调' : cell.met ? '✓' : cell.hours > 0 ? '◐' : '·';
  return `${String(cell.day).padStart(2)}${mark}`.padEnd(4);
}

/** 日期性质。 */
function calKindLabel(cell) {
  if (cell.kind === 'holiday') return `法定节假日${cell.holiday ? `（${cell.holiday}）` : ''}`;
  if (cell.kind === 'adjusted-workday') return `调休上班${cell.holiday ? `（${cell.holiday}）` : ''}`;
  if (cell.kind === 'weekend') return '周末';
  return '法定工作日';
}

/* ------------------------------------------------------------------ *
 * workbench_report
 * ------------------------------------------------------------------ */

/** 报表工具。 */
export function reportTool(store) {
  return {
    name: 'workbench_report',
    description:
      '生成、润色与归档「AI 工作台账」的周报/月报/年报，以及统计。两种维度：时间维度（type=weekly/monthly/yearly；**周报默认是「上周五 ~ 本周四」**（已经过完的那一周，不是周一到周日、也不含今天之后）；按 date 定位所在周/月/年，或用 from+to 指定任意区间——周报的自定义区间也走 from+to）与项目维度（type=project，必须给 project）。关键工作流：先 action=draft 拿到「结构化事实 facts + 默认 Markdown 草稿 + reportId」，再**基于 facts 里的真实记录**把草稿润色成有叙述的正文，最后 action=save 写回、action=archive 归档。facts 在生成时已冻结进报表，之后补录工时不会污染历史。严禁编造 facts 里没有的工作内容。周报（type=weekly）默认用内置精简版式：`本周完成：` + 按项目分段的 `【项目名】` + `1.事项名（30%）`，最后是 `下周待办：` 与编号条目。若用户在设置里配了自定义报表模板，则以自定义模板为准（可用 {{title}} / {{weeklyCompleted}} / {{nextWeek}} / {{hours}} 等占位符）。润色时不要编造 facts 里没有的内容。月报 / 年报 / 项目维度用叙述式正文。action 取值：draft（生成草稿）、save（写回 content/title）、finalize（定稿）、archive（归档，内容冻结且不可编辑不可删除）、append_file（把这份报表追加到本机周报汇总文件的末尾，格式是 `#### 起始日-结束日 - 署名` + 代码块包住的正文）、revise（基于归档版出新修订草稿）、rerender（按当前模板重渲染）、list（检索）、get（读取单份）、remove（删除，归档版不可删）、archive_stale（一键归档所有区间已结束的草稿）、stats（日/月/年统计：dim=day|month|year + from/to，或 project 过滤）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['draft', 'save', 'finalize', 'archive', 'append_file', 'revise', 'rerender', 'list', 'get', 'remove', 'archive_stale', 'stats'],
          description: '要执行的操作。',
        },
        type: { type: 'string', enum: ['weekly', 'monthly', 'yearly', 'project'], description: '报表类型，默认 weekly。' },
        date: { type: 'string', description: '定位区间的基准日 YYYY-MM-DD，默认今天（如周报取该日所在的 ISO 周）。' },
        from: { type: 'string', description: '自定义区间起 YYYY-MM-DD。' },
        to: { type: 'string', description: '自定义区间止 YYYY-MM-DD。' },
        project: { type: 'string', description: '项目名或 id（项目维度报表。' },
        id: { type: 'string', description: '报表 id（save/get/finalize/archive/revise/rerender/remove）。' },
        title: { type: 'string', description: '自定义标题（draft/save）。' },
        content: { type: 'string', description: '报表正文 Markdown（draft 时作为初始正文，save 时写回）。' },
        status: { type: 'string', description: 'list：状态过滤 draft/final/archived/all。' },
        q: { type: 'string', description: 'list：关键词搜索。' },
        dim: { type: 'string', enum: ['day', 'month', 'year'], description: 'stats：统计粒度，默认 month。' },
        limit: { type: 'number', description: 'list：最多返回多少条，默认 30。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const action = String(args?.action ?? '');
      const { value } = await store.run(args?.date, async (state, key) => {
        if (action === 'stats') {
          const dim = ['day', 'month', 'year'].includes(args?.dim) ? args.dim : 'month';
          const view = statsView(state, { dim, from: args?.from, to: args?.to, today: key });
          return reportStatsText(view);
        }

        if (action === 'list') {
          const view = reportsView(state, { status: args?.status, q: args?.q, projectId: args?.project });
          const limit = clampInt(args?.limit, 1, 200, 30);
          const rows = view.reports.slice(0, limit);
          return lines(
            `报表共 ${view.total} 份（草稿 ${view.counts.draft} · 已定稿 ${view.counts.final} · 已归档 ${view.counts.archived}）`,
            '',
            rows.length === 0
              ? '  （没有匹配的报表）'
              : rows
                  .map(
                    (item) =>
                      `  [${statusLabel(item.status)}] ${item.title}  ${item.from}~${item.to}${
                        item.totals ? `  ${item.totals.done} 项 / ${fmtHours(item.totals.hours)}` : ''
                      }  \`${item.id}\``,
                  )
                  .join('\n'),
          );
        }

        if (action === 'get') {
          const view = reportView(state, args?.id);
          if (!view) return `❌ 找不到报表「${args?.id}」`;
          return lines(
            `《${view.title}》 · ${statusLabel(view.status)} · v${view.revision} · ${view.from} ~ ${view.to}`,
            view.archivedAt ? `归档于 ${String(view.archivedAt).slice(0, 10)}${view.editable ? '' : '（只读）'}` : '',
            '',
            view.content,
          );
        }

        if (action === 'draft') {
          const projectRef = args?.project ? findProjectRef(state, args.project) : null;
          if (args?.project && !projectRef) return `❌ 找不到项目「${args.project}」`;
          if (args?.type === 'project' && !projectRef) return '❌ 项目维度的报表必须给 project 参数';
          const created = applyAction(state, key, 'report_create', {
            type: args?.type,
            date: args?.date ?? key,
            from: args?.from,
            to: args?.to,
            projectId: projectRef?.id ?? null,
            title: args?.title,
            content: args?.content,
            generatedBy: 'workbench_report',
          });
          if (!created.ok) return `❌ ${created.error}`;
          return lines(
            created.message,
            `reportId: ${created.result.id}`,
            '',
            '─ 结构化事实（请只依据这些内容撰写，不要编造）─',
            factsSummaryText(created.result.report.facts),
            '',
            '─ 默认草稿（可润色后用 action=save 写回）─',
            '',
            created.result.report.content,
          );
        }

        const mapped = {
          save: 'report_save',
          finalize: 'report_finalize',
          archive: 'report_archive',
          append_file: 'report_append_file',
          revise: 'report_revise',
          rerender: 'report_rerender',
          remove: 'report_delete',
          archive_stale: 'report_archive_stale',
        }[action];
        if (!mapped) return `未知操作「${action}」`;

        const result = applyAction(state, key, mapped, {
          id: args?.id,
          reportId: args?.id,
          title: args?.title,
          content: args?.content,
        });
        if (!result.ok) return `❌ ${result.error}`;
        const view = result.result?.report ? reportView(state, result.result.id) : null;
        return lines(
          result.message,
          view ? `《${view.title}》 · ${statusLabel(view.status)} · v${view.revision} · ${view.from} ~ ${view.to}` : '',
        );
      });
      return value;
    },
  };
}

/** 在 state 里找项目（避免与 actions 循环依赖，这里做一次轻量查找）。 */
function findProjectRef(state, ref) {
  const needle = String(ref).trim().toLowerCase();
  return (
    state.projects.find((item) => item.id === ref) ??
    state.projects.find((item) => item.name.toLowerCase() === needle || (item.code && item.code.toLowerCase() === needle)) ??
    state.projects.find((item) => item.name.toLowerCase().includes(needle)) ??
    null
  );
}

/** 事实摘要（给 Agent 看，避免它只能靠草稿猜）。 */
function factsSummaryText(facts) {
  if (!facts) return '（没有冻结快照）';
  const out = [
    `区间：${facts.meta.from} ~ ${facts.meta.to}（${facts.meta.label ?? ''}）`,
    `完成 ${facts.totals.done} 项 · 放弃 ${facts.totals.dropped} 项 · 漏做 ${facts.totals.missed} 项 · 顺延中 ${facts.totals.carryOverOpen} 项`,
    `完成率 ${facts.totals.completionRate}% · 按时完成率 ${facts.totals.onTimeRate}%`,
    `工时：法定工作日 ${facts.legs.workdays} 天，计划 ${fmtHours(facts.legs.planHours)}，必须 ${fmtHours(facts.legs.requiredHours)}，实际 ${fmtHours(facts.legs.loggedHours)}（${facts.legs.achievement}%）`,
  ];
  if (facts.byProject.length > 0) {
    out.push('', '按项目：');
    for (const group of facts.byProject) {
      out.push(`  ${group.emoji} ${group.name}：${group.done} 项 / ${fmtHours(group.hours)}`);
      for (const item of group.highlights.slice(0, 8)) out.push(`    - ${item}`);
    }
  }
  if (facts.carriedOver.length > 0) {
    out.push('', '未完成：');
    for (const item of facts.carriedOver.slice(0, 10)) out.push(`  - ${item.title}（顺延 ${item.rolloverCount} 天）`);
  }
  return out.join('\n');
}

/** 统计文本。 */
function reportStatsText(view) {
  const dimLabel = { day: '按天', month: '按月', year: '按年' }[view.dim];
  const head = [
    `📈 统计 · ${dimLabel} · ${view.from} ~ ${view.to}`,
    `完成 ${view.totals.done} 项 · 放弃 ${view.totals.dropped} · 漏做 ${view.totals.missed} · 新建 ${view.totals.created}`,
    `完成率 ${view.totals.completionRate}% · 按时完成率 ${view.totals.onTimeRate}%`,
    `工时：法定工作日 ${view.legs.workdays} 天，必须 ${fmtHours(view.legs.requiredHours)}，实际 ${fmtHours(view.legs.loggedHours)}（${view.legs.achievement}%）`,
    '',
  ];
  const rows = view.buckets
    .filter((bucket) => bucket.done > 0 || bucket.planned > 0 || bucket.hours > 0)
    .map(
      (bucket) =>
        `  ${String(bucket.label).padEnd(12)} 完成 ${String(bucket.done).padStart(3)}  计划 ${String(bucket.planned).padStart(3)}  完成率 ${String(bucket.completionRate).padStart(5)}%  工时 ${String(bucket.hours).padStart(6)}h`,
    );
  return lines(...head, rows.length > 0 ? rows.join('\n') : '  （区间内没有记录）');
}

/** 报表状态中文。 */
function statusLabel(status) {
  if (status === REPORT_STATUS.ARCHIVED) return '已归档';
  if (status === REPORT_STATUS.FINAL) return '已定稿';
  return '草稿';
}
