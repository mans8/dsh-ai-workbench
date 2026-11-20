/**
 * AI 工作台账 — Agent 工具。
 *
 * 两个工具按域拆分（待办 / 报表），而不是塞进一个巨型 action 枚举：
 * 每个工具的 schema 更短、意图边界更清晰，模型选错的概率显著更低。
 * 两个工具与浏览器面板共用同一套领域函数（domain.js / actions.js），
 * 所以「面板能做的，Agent 都能做」，反之亦然。
 */
import { applyAction } from './actions.js';
import { projectsView, reportView, reportsView, statsView, todayView, todosView } from './domain.js';
import { REPORT_STATUS } from './state.js';
import { categoryScopeLabel } from './reports.js';
import { clampInt } from './util.js';

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
      '查询与操作「AI 工作台账」的待办清单。核心机制：没做完的待办一直留在今日列表里，直到完成或放弃，同一件事、同一条记录，所以永远不会丢事。待办可归属项目、带优先级（P0 重要且紧急/P1 重要不紧急/P2 紧急不重要/P3 不重要不紧急，默认 P1）、硬截止日；带 repeat 的待办会变成「重复任务模板」并自动开出当天实例。action 取值：today（今日战报，默认从这里开始）、list（列表，可按 project/status/from/to/tag/q 过滤；from/to 表示「与区间有交集」，未完成看创建时间、已完成看完成日、已放弃看放弃日）、add（新建，repeat 传 {freq:"daily"|"workdays"|"weekdays"|"weekly"|"monthly", weekdays:[0-6], monthDays:[1-31]} 即成为重复任务）、update、remove、complete（完成任务，可带 note）、undo（撤销完成，只作废事实流水）、drop（放弃，需 reason）、restore（恢复）、project_add/project_update/project_remove/project_list（项目管理）。task 参数可传待办标题（支持部分匹配）或 id。',
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
            'project_add',
            'project_update',
            'project_remove',
            'project_list',
          ],
          description: '要执行的操作。',
        },
        task: { type: 'string', description: '待办标题（支持部分匹配）或 id。' },
        title: { type: 'string', description: '待办标题（add/update），或随手记内容。' },
        note: { type: 'string', description: '说明（add/update/complete）。' },
        project: { type: 'string', description: '项目名、代号或 id（add/update/list 过滤）。' },
        priority: {
          type: 'string',
          enum: ['P0', 'P1', 'P2', 'P3'],
          description:
            '优先级（四象限），默认 P1。含义：P0 重要且紧急=立即做（线上故障、阻塞别人、当天必须交付）；P1 重要不紧急=排期做（本周要交付、别人在等）；P2 紧急不重要=委派或批量处理；P3 不重要不紧急=删除或归档。',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '标签。' },
        dueDate: { type: 'string', description: '硬截止日 YYYY-MM-DD（留空字符串可清除）。' },
        progress: {
          type: 'number',
          description: '完成度 0~100，只用于汇报口径。周报草稿会写成「1.事项名（30%）」；做完的待办一律按 100% 呈现，不看这个字段。',
        },
        repeat: { type: 'object', description: '重复规则：{freq, weekdays?, monthDays?}；不传则是一次性待办。' },
        reason: { type: 'string', description: '放弃原因（drop）或项目说明。' },
        enabled: { type: 'boolean', description: 'update：启用/停用重复任务模板。' },
        emoji: { type: 'string', description: '项目图标（project_add/project_update）。' },
        code: { type: 'string', description: '项目代号（project_add/project_update）。' },
        category: { type: 'string', enum: ['work', 'personal'], description: '项目分类：work 工作 / personal 个人（project_add/project_update）。' },
        status: { type: 'string', description: 'list：状态过滤 open/done/dropped/all；project_update：active/paused/archived。' },
        q: { type: 'string', description: 'list：关键词搜索标题与说明。' },
        tag: { type: 'string', description: 'list：按标签过滤。' },
        includeDone: { type: 'boolean', description: 'list：是否包含已完成的（默认包含）。' },
        limit: { type: 'number', description: 'list：最多返回多少条，默认 40。' },
        date: { type: 'string', description: 'target date，默认今天（today 视图用；报表用它定位所在周/月/年）。' },
        from: {
          type: 'string',
          description:
            '区间起点 YYYY-MM-DD。list：「与区间有交集」的下界（未完成看创建时间、已完成看完成日、已放弃看放弃日）；report：自定义区间起点（与 to 一起给时优先于 date）。',
        },
        to: { type: 'string', description: '区间终点 YYYY-MM-DD。list / report 同上。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const action = String(args?.action ?? '');
      const { value } = await store.run(args?.date, (state, key, rollover) => {
        const rolloverNote = carryOverSummary(rollover);

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
            `待办共 ${view.total} 条（进行中 ${view.counts.open} · 已完成 ${view.counts.done} · 已放弃 ${view.counts.dropped}）${
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
            rows.map((p) => `  ${p.emoji} ${p.name}${p.code ? `（${p.code}）` : ''} · ${p.category === 'personal' ? '个人' : '工作'} · ${p.status} · 进行中 ${p.openCount} / 已完成 ${p.doneCount}`).join('\n'),
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
          dueDate: args?.dueDate,
          progress: args?.progress,
          repeat: args?.repeat,
          reason: args?.reason,
          enabled: args?.enabled,
          emoji: args?.emoji,
          code: args?.code,
          category: args?.category,
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
          `今日：待办 ${after.stats.plannedCount} 项 · 完成 ${after.stats.doneCount} 项`,
          projectArg ? `项目 ${projectArg.emoji}${projectArg.name}：进行中 ${after.todos.filter((t) => t.projectId === projectArg.id).length} 项` : '',
          before.stats.overdueCount !== after.stats.overdueCount ? `⚠️ 逾期项从 ${before.stats.overdueCount} 变为 ${after.stats.overdueCount}` : '',
          rolloverNote,
        );
      });
      return value;
    },
  };
}

/** 把跨日补算结果压成一行提示。 */
function carryOverSummary(rollover) {
  if (!rollover || !rollover.days) return '';
  if (rollover.created.length === 0) return '';
  return `🔄 开出 ${rollover.created.length} 条重复任务`;
}

/** 今日战报文本。 */
function reportTodayText(view) {
  const head = `📅 ${view.date} 周${view.weekday} · ${view.weekLabel} · ${kindLabel(view)}`;
  const chips = [
    `待办 ${view.stats.plannedCount} 项`,
    `今天完成 ${view.stats.doneCount} 项`,
    `本周完成 ${view.stats.weekDoneCount} 项`,
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

  if (view.overdue.length > 0) {
    sections.push('▸ 🔴 已逾期');
    sections.push(view.overdue.map((item) => `  ${item.title}（截止 ${item.dueDate}，逾期 ${item.overdueDays} 天）`).join('\n'));
    sections.push('');
  }

  if (view.logs.length > 0) {
    sections.push('▸ 今日流水');
    sections.push(view.logs.map((log) => `  ${String(log.at).slice(11, 16)}  ${log.title}`).join('\n'));
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
 * workbench_report
 * ------------------------------------------------------------------ */

/** 报表工具。 */
export function reportTool(store) {
  return {
    name: 'workbench_report',
    description:
      '生成、润色与归档「AI 工作台账」的周报/月报/年报，以及统计。两种维度：时间维度（type=weekly/monthly/yearly；**周报默认是「本周一 ~ 本周五」**；按 date 定位所在周/月/年，或用 from+to 指定任意区间——周报的自定义区间也走 from+to）与项目维度（type=project，必须给 project）。关键工作流：先 action=draft 拿到「结构化事实 facts + 默认 Markdown 草稿 + reportId」，再**基于 facts 里的真实记录**把草稿润色成有叙述的正文，最后 action=save 写回、action=archive 归档。facts 在生成时已冻结进报表，之后补录流水不会污染历史。严禁编造 facts 里没有的工作内容。周报（type=weekly）默认用内置版式：首行 `标题前缀（2026.11.9-2026.11.13）`，然后是 `一、本周总结` 与 `二、下周计划`，两节都按项目分组（`1.项目名` + 缩进的 `  1）事项`），不写百分比、不展开说明。若用户在设置里配了自定义简报模板，则以自定义模板为准（可用 {{title}} / {{weeklyCompleted}} / {{nextPlan}}（别名 {{nextWeek}}） / {{stats}} 等占位符）。时间维度可用 category 按项目分类过滤（all 全部 / work 仅工作 / personal 仅个人，默认 all；没有项目的条目算工作；项目维度忽略）。润色时不要编造 facts 里没有的内容。月报 / 年报 / 项目维度用叙述式正文。action 取值：draft（生成草稿）、save（写回 content/title）、finalize（定稿）、archive（归档，内容冻结且不可编辑不可删除）、append_file（把这份报表追加到本机周报汇总文件的末尾，格式是 `#### 起始日-结束日 - 署名` + 代码块包住的正文）、revise（基于归档版出新修订草稿）、rerender（按当前模板重渲染）、list（检索）、get（读取单份）、remove（删除，归档版不可删）、archive_stale（一键归档所有区间已结束的草稿）、stats（日/月/年统计：dim=day|month|year + from/to，或 project 过滤）。',
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
        category: {
          type: 'string',
          enum: ['all', 'work', 'personal'],
          description: 'draft：项目分类口径 —— all 全部 / work 仅工作 / personal 仅个人，默认 all。没有项目的条目算工作；项目维度忽略此参数。',
        },
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
                        item.totals ? `  ${item.totals.done} 项` : ''
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
            category: args?.category ?? 'all',
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
    `分类口径：${categoryScopeLabel(facts.meta.categoryScope)}`,
    `完成 ${facts.totals.done} 项 · 放弃 ${facts.totals.dropped} 项 · 漏做 ${facts.totals.missed} 项 · 未完成 ${facts.totals.carryOverOpen} 项`,
    `完成率 ${facts.totals.completionRate}%`,
  ];
  if (facts.byProject.length > 0) {
    out.push('', '按项目：');
    for (const group of facts.byProject) {
      out.push(`  ${group.emoji} ${group.name}：${group.done} 项`);
      for (const item of group.highlights.slice(0, 8)) out.push(`    - ${item}`);
    }
  }
  if (facts.carriedOver.length > 0) {
    out.push('', '未完成：');
    for (const item of facts.carriedOver.slice(0, 10)) out.push(`  - ${item.title}`);
  }
  return out.join('\n');
}

/** 统计文本。 */
function reportStatsText(view) {
  const dimLabel = { day: '按天', month: '按月', year: '按年' }[view.dim];
  const head = [
    `📈 统计 · ${dimLabel} · ${view.from} ~ ${view.to}`,
    `完成 ${view.totals.done} 项 · 放弃 ${view.totals.dropped} · 漏做 ${view.totals.missed} · 新建 ${view.totals.created}`,
    `完成率 ${view.totals.completionRate}%`,
    '',
  ];
  const rows = view.buckets
    .filter((bucket) => bucket.done > 0 || bucket.planned > 0)
    .map(
      (bucket) =>
        `  ${String(bucket.label).padEnd(12)} 完成 ${String(bucket.done).padStart(3)}  计划 ${String(bucket.planned).padStart(3)}  完成率 ${String(bucket.completionRate).padStart(5)}%`,
    );
  return lines(...head, rows.length > 0 ? rows.join('\n') : '  （区间内没有记录）');
}

/** 报表状态中文。 */
function statusLabel(status) {
  if (status === REPORT_STATUS.ARCHIVED) return '已归档';
  if (status === REPORT_STATUS.FINAL) return '已定稿';
  return '草稿';
}
