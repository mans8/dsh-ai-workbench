/**
 * AI 工作台账 · AI Workbench — Host 半体（插件入口）。
 *
 * 只留在本机的账：做过的事留得下、汇报报得出。
 *
 * 架构：本文件只做三件事 —— 串行化状态仓库、一条 HTTP 路由、两个 Agent 工具。
 * 全部业务逻辑在同目录的 lib/ 下：
 *   lib/util.js      日期与数值工具
 *   lib/calendar.js  中国法定工作日日历（data/china-holidays.json）
 *   lib/state.js     状态模型 + 惰性顺延引擎（唯一权威）
 *   lib/domain.js    派生视图（今日/待办/项目/统计）
 *   lib/reports.js   报表 fact 聚合 + Markdown 渲染
 *   lib/actions.js   全部写操作
 *   lib/tools.js     Agent 工具定义
 *
 * 面板与 Agent 调用完全相同的领域函数，因此不存在「面板能做的工具做不了」。
 * 数据落在 ~/ai-workbench/state.json，原子写入。
 */
import { applyAction } from './lib/actions.js';
import { bootstrapView, projectsView, reportView, reportsView, statsView, todayView, todosView } from './lib/domain.js';
import { readState, rolloverThrough, writeState } from './lib/state.js';
import { reportTool, todoTool } from './lib/tools.js';
import { dayKeyOf, isKey, normalizeKey } from './lib/util.js';

/** Cordis 函数插件名。 */
export const name = 'ai-workbench';
/** webServer/connection 提供 HTTP 承载与信任栅栏；tools 提供 Agent 工具。 */
export const inject = ['webServer', 'connection', 'tools'];

/** 浏览器面板与 Agent 工具共用的唯一接口路径。 */
const ROUTE = '/ai-workbench/api';
/** POST 体积上限（正常请求只有几 KB；报表正文可能较大）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Host 半体：一个串行化的状态仓库 + 一条 HTTP 路由 + 两个 Agent 工具。
 * @param ctx Cordis 上下文。
 * @param config 行 config（可覆盖 holidayOverrides）。
 */
export function apply(ctx, config) {
  /** 懒加载 + 变更串行化，避免并发写丢更新。 */
  let loaded = null;
  let queue = Promise.resolve();

  /** 首次载入时把行 config 的默认值种进状态（之后以面板/工具的修改为准）。 */
  function seed(state) {
    if (state.meta.seeded === true) return state;
    const s = config && typeof config === 'object' ? config : {};
    if (s.holidayOverrides && typeof s.holidayOverrides === 'object') {
      state.settings.holidayOverrides = { ...state.settings.holidayOverrides, ...s.holidayOverrides };
    }
    state.meta.seeded = true;
    return state;
  }

  const load = async () => {
    if (!loaded) loaded = seed(await readState());
    return loaded;
  };

  /**
   * 在串行事务里读改写状态：先把顺延补算推到目标日期，再执行调用方逻辑，最后原子落盘。
   * @param date 目标日期（空 = 今天）
   * @param fn (state, key, rollover) => value
   * @returns {{ value, rollover }}
   */
  function run(date, fn) {
    const task = queue.then(async () => {
      const state = await load();
      const key = normalizeKey(date ?? dayKeyOf());
      const rollover = rolloverThrough(state, key);
      const value = await fn(state, key, rollover);
      state.cursor.lastSeenAt = new Date().toISOString();
      await writeState(state);
      return { value, rollover };
    });
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  const store = { run };

  /** 信任栅栏：409/401/403 之类的拒绝先于任何数据返回。 */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  /**
   * 按 view 参数构造只读视图。
   * @returns 视图对象；未知 view 返回 null
   */
  function viewOf(state, today, params) {
    const p = (key) => params.get(key);
    const dateParam = p('date');
    const date = isKey(dateParam) ? dateParam : today;
    const view = p('view') ?? 'bootstrap';

    switch (view) {
      case 'bootstrap':
        return bootstrapView(state, today);
      case 'today':
        return todayView(state, date);
      case 'todos':
        return todosView(state, {
          today: date,
          projectId: p('projectId') || null,
          status: p('status') || 'all',
          q: p('q') || '',
          tag: p('tag') || null,
          from: p('from') || null,
          to: p('to') || null,
          includeTemplates: p('templates') === '1',
          archived: p('archived') === '1',
        });
      case 'projects':
        return projectsView(state, { today: date });
      case 'stats':
        return statsView(state, {
          today: date,
          dim: p('dim') || 'month',
          from: p('from') || null,
          to: p('to') || null,
          projectId: p('projectId') || null,
          heatmap: p('heatmap') === '1',
        });
      case 'reports':
        return reportsView(state, {
          type: p('type') || null,
          dimension: p('dimension') || null,
          projectId: p('projectId') || null,
          status: p('status') || 'all',
          q: p('q') || '',
          from: p('from') || null,
          to: p('to') || null,
        });
      case 'report':
        return reportView(state, p('id'));
      default:
        return null;
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          try {
            const url = new URL(String(req.url ?? ROUTE), 'http://localhost');

            if (req.method === 'GET') {
              // `today` 驱动顺延补算；`date` 只是视图要看的那一天。两者分开，
              // 才能做到「查看历史某天，但顺延仍然只推进到今天」。
              const runKey = isKey(url.searchParams.get('today')) ? url.searchParams.get('today') : dayKeyOf();
              const payload = await run(runKey, (state, key) => {
                const view = viewOf(state, key, url.searchParams);
                if (view === null) return { error: `未知 view「${url.searchParams.get('view')}」` };
                return { view };
              });
              if (payload.value.error) {
                sendJson(res, 400, { ok: false, error: payload.value.error });
                return;
              }
              sendJson(res, 200, { ok: true, view: payload.value.view, rollover: rolloverEffect(payload.rollover) });
              return;
            }

            if (req.method === 'POST') {
              const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
              if (contentType !== 'application/json') {
                sendJson(res, 415, { ok: false, error: 'content-type 必须是 application/json' });
                return;
              }
              const text = await readBody(req);
              if (text === null) {
                sendJson(res, 413, { ok: false, error: '请求体过大' });
                return;
              }
              let body;
              try {
                body = JSON.parse(text);
              } catch {
                sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
                return;
              }
              if (!body || typeof body !== 'object' || typeof body.action !== 'string') {
                sendJson(res, 400, { ok: false, error: '缺少 action' });
                return;
              }

              const runKey = isKey(body.today) ? body.today : dayKeyOf();
              const payload = await run(runKey, (state, key) => {
                const before = todayView(state, key);
                const result = applyAction(state, key, body.action, body);
                const after = todayView(state, key);

                let view = null;
                if (typeof body.view === 'string' && body.view !== '') {
                  const params = new URLSearchParams();
                  params.set('view', body.view);
                  for (const [k, v] of Object.entries(body.viewParams ?? {})) {
                    if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
                  }
                  view = viewOf(state, key, params);
                }

                return {
                  result,
                  view: view ?? after,
                  effects: {
                    action: body.action,
                    plannedDelta: after.stats.plannedCount - before.stats.plannedCount,
                    doneDelta: after.stats.doneCount - before.stats.doneCount,
                    backlogDelta: after.stats.backlogCount - before.stats.backlogCount,
                    overdueDelta: after.stats.overdueCount - before.stats.overdueCount,
                    todayDone: after.stats.doneCount,
                  },
                };
              });

              const action = payload.value.result;
              sendJson(res, 200, {
                ok: true,
                result: {
                  ok: action.ok === true,
                  message: action.message ?? '',
                  error: action.ok === true ? null : (action.error ?? '未知错误'),
                  data: action.result ?? null,
                },
                view: payload.value.view,
                effects: payload.value.effects,
                rollover: rolloverEffect(payload.rollover),
              });
              return;
            }

            res.statusCode = 405;
            res.setHeader('allow', 'GET, POST');
            res.end();
          } catch (error) {
            console.warn(`[ai-workbench] 请求处理失败：${error?.stack ?? error}`);
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      }),
    `ai-workbench: ${ROUTE}`,
  );

  ctx.effect(() => ctx.tools.register(todoTool(store)), 'ai-workbench: workbench_todo tool');
  ctx.effect(() => ctx.tools.register(reportTool(store)), 'ai-workbench: workbench_report tool');

  console.log(`[ai-workbench] 已就绪：${ROUTE} · 工具 workbench_todo / workbench_report`);
}

/** 把顺延结果压成给前端用的小结（没有推进则为 null）。 */
function rolloverEffect(rollover) {
  if (!rollover || !rollover.days) return null;
  return {
    days: rollover.days,
    moved: rollover.moved.length,
    created: rollover.created.length,
    missed: rollover.missed.length,
    entries: rollover.moved.slice(-5).map((item) => ({ title: item.title, from: item.from, to: item.to })),
  };
}

/** JSON 响应（no-store：待办与流水都是实时事实）。 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** 收一个限长请求体。 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}
