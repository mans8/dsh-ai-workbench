/** 区间天数（含首尾），测试里用。 */
function dayCount(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
}

/**
 * AI 工作台账 — Host 半体端到端测试（mock Cordis ctx）。
 *
 * 不依赖真实 DSH：伪造 webServer/connection/tools 三个服务，把 HTTP 路由当成
 * 被测接口驱动，覆盖顺延、重复任务、工时口径、统计与报表归档这几条核心路径。
 *
 * 时间完全由 `today` 参数驱动（时钟木偶），所以测试与机器真实日期无关：
 *   A.day('2026-10-13')   → 之后的请求都当作「今天是 10-13」
 *
 * 运行：node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_DIR = join(HERE, '..');

/* ------------------------------------------------------------------ *
 * 测试脚手架
 * ------------------------------------------------------------------ */

const ROOT = mkdtempSync(join(tmpdir(), 'aiwb-test-'));

let passed = 0;
const failures = [];

/** 一条断言。 */
function check(label, fn) {
  let result;
  try {
    result = fn();
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label}\n      ${String(error.message).split('\n').join('\n      ')}`);
    return;
  }
  // 传成 async 函数时断言跑在微任务里，try/catch 抓不到，用例会「永远通过」。
  // 这种空转比失败更危险，所以直接判红。
  if (result && typeof result.then === 'function') {
    const error = new Error('这个用例是 async 的，必须用 await checkAsync(...) 包起来，否则断言不会被执行');
    failures.push({ label, error });
    console.log(`  ✗ ${label}\n      ${error.message}`);
    return;
  }
  passed += 1;
  console.log(`  ✓ ${label}`);
}

/** 异步断言（需要再发一个请求时用）。 */
async function checkAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label}\n      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

/** 分组标题。 */
function group(title) {
  console.log(`\n${title}`);
}

/** 伪造响应对象。 */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    end(body) {
      this.body = body ?? null;
    },
  };
}

/** 伪造请求对象（POST 时带上 JSON body）。 */
function makeReq(method, url, body, contentType = 'application/json') {
  const headers = {};
  if (body !== undefined) headers['content-type'] = contentType;
  return {
    method,
    url,
    headers,
    resume() {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
    },
  };
}

/**
 * 起一个隔离的插件实例。
 * @param label 临时目录名（同时保证模块 URL 唯一）
 * @param config 行 config
 * @param startDay 时钟起点
 */
async function harness(label, config = {}, startDay = '2026-10-12') {
  const home = join(ROOT, label);
  process.env.AI_WORKBENCH_STATE_FILE = join(home, 'state.json');
  process.env.DSH_HOME = home; // 旧路径也指向临时目录，避免误迁移真实数据
  const routes = new Map();
  const tools = new Map();
  const ctx = {
    effect: (fn) => fn(),
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
  };
  const mod = await import(`${join(PLUGIN_DIR, 'index.js')}?v=${encodeURIComponent(label)}`);
  mod.apply(ctx, config);

  const route = routes.get('/ai-workbench/api');
  assert.ok(route, '路由未注册');

  async function call(method, url, body, contentType) {
    const res = makeRes();
    await route.handler(makeReq(method, url, body, contentType ?? 'application/json'), res);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  }

  const api = {
    home,
    tools,
    stateFile: join(home, 'state.json'),
    /** 时钟木偶：设置「今天」。 */
    clock: startDay,
    day(value) {
      api.clock = value;
      return api;
    },
    /** GET 一个视图。 */
    async get(view, params = {}) {
      const query = new URLSearchParams({ view, today: api.clock, ...params });
      const res = await call('GET', `/ai-workbench/api?${query}`);
      assert.equal(res.status, 200, `GET ${view} HTTP ${res.status}：${res.json?.error}`);
      assert.equal(res.json.ok, true, `GET ${view} 返回 ok=false：${res.json?.error}`);
      return res.json;
    },
    /** 原始 POST（不注入时钟），用于测协议层。 */
    raw(body) {
      return call('POST', '/ai-workbench/api', body);
    },
    /** 指定 content-type 的原始 POST。 */
    rawTyped(body, contentType) {
      return call('POST', '/ai-workbench/api', body, contentType);
    },
    /** POST 一个写操作，返回原始响应。 */
    async post(body) {
      return call('POST', '/ai-workbench/api', { today: api.clock, ...body });
    },
    /** POST 并断言业务成功，返回 { ok, message, error, data }。 */
    async ok(body) {
      const res = await api.post(body);
      assert.equal(res.status, 200, `POST ${body.action} HTTP ${res.status}：${res.json?.error}`);
      assert.equal(res.json.ok, true, `POST ${body.action} 信封 ok=false：${res.json?.error}`);
      assert.equal(res.json.result.ok, true, `POST ${body.action} 业务失败：${res.json.result.error}`);
      return res.json.result;
    },
    /** 调一个 Agent 工具。 */
    async tool(name, args) {
      const tool = tools.get(name);
      assert.ok(tool, `工具 ${name} 未注册`);
      return tool.execute(args);
    },
    readState() {
      return JSON.parse(readFileSync(api.stateFile, 'utf8'));
    },
  };
  return api;
}

const { holidayInfo, workdaysInMonth, isWorkday, dayKind } = await import(join(PLUGIN_DIR, 'lib', 'calendar.js'));
const { normalizeState } = await import(join(PLUGIN_DIR, 'lib', 'state.js'));

check('normalizeState 保留 meta.seeded（否则重启会重新覆盖用户设置）', () => {
  assert.equal(normalizeState({ meta: { seeded: true } }).meta.seeded, true);
  assert.equal(normalizeState({ meta: {} }).meta.seeded, false);
});

/* ------------------------------------------------------------------ *
 * 1. 日历与法定工作日
 * ------------------------------------------------------------------ */

group('1. 日历与法定工作日（2026）');
{
  const info = holidayInfo();
  check('日历资产覆盖到 2026 年且无加载错误', () => {
    assert.equal(info.maxYear, 2026);
    assert.ok(info.holidayCount > 500);
    assert.equal(info.error, null);
  });

  const expected = { 1: 21, 2: 16, 3: 22, 4: 21, 5: 19, 6: 21, 7: 23, 8: 21, 9: 22, 10: 18, 11: 21, 12: 23 };
  check('2026 全年 12 个月的法定工作日与设计文档一致', () => {
    for (const [m, days] of Object.entries(expected)) {
      assert.equal(workdaysInMonth(`2026-${String(m).padStart(2, '0')}`), days, `${m} 月`);
    }
  });

  check('2026 全年 248 个法定工作日 → 计划 1860h → 必须 2046h', () => {
    const total = Object.keys(expected).reduce((sum, m) => sum + workdaysInMonth(`2026-${String(m).padStart(2, '0')}`), 0);
    assert.equal(total, 248);
    assert.equal(total * 7.5, 1860);
    assert.equal(Math.round(total * 7.5 * 1.1 * 100) / 100, 2046);
  });

  check('10-10 是调休上班日，10-01 是节假日，10-11 是周末', () => {
    assert.equal(isWorkday('2026-10-10'), true);
    assert.equal(dayKind('2026-10-10'), 'adjusted-workday');
    assert.equal(dayKind('2026-10-01'), 'holiday');
    assert.equal(dayKind('2026-10-11'), 'weekend');
    assert.equal(dayKind('2026-10-12'), 'workday');
  });
}

/* ------------------------------------------------------------------ *
 * 2. 待办与惰性顺延
 * ------------------------------------------------------------------ */

const A = await harness('rollover');

group('2. 待办清单与跨日顺延');
{
  const boot = await A.get('bootstrap');
  check('bootstrap 返回今日、设置与工时概览', () => {
    assert.equal(boot.view.today, '2026-10-12');
    assert.equal(boot.view.settings.dailyHours, 7.5);
    assert.equal(boot.view.settings.gradeFactor, 1.1);
    assert.equal(boot.view.hours.workdays, 18);
    assert.equal(boot.view.hours.planHours, 135);
    assert.equal(boot.view.hours.requiredHours, 148.5);
  });

  check('状态文件已落盘', () => {
    assert.ok(existsSync(A.stateFile));
  });

  await A.ok({ action: 'project_create', name: '订单中台', code: 'OMS', emoji: '📦', status: 'active' });
  const created = await A.ok({
    action: 'todo_create',
    title: '订单导出接口重构',
    project: '订单中台',
    plannedDate: '2026-10-12',
    estimateHours: 8,
    priority: 'P1',
  });
  const todoId = created.data.id;

  const today1 = await A.get('today');
  check('今天建立的待办出现在今天的列表里', () => {
    assert.equal(today1.view.todos.length, 1);
    assert.equal(today1.view.todos[0].title, '订单导出接口重构');
    assert.equal(today1.view.todos[0].projectName, '订单中台');
    assert.equal(today1.view.todos[0].carried, false);
  });

  const day2 = await A.day('2026-10-13').get('today');
  check('次日未完成 → 顺延 1 天，仍是同一条记录', () => {
    assert.equal(day2.view.todos.length, 1);
    assert.equal(day2.view.todos[0].id, todoId);
    assert.equal(day2.view.todos[0].plannedDate, '2026-10-13');
    assert.equal(day2.view.todos[0].rolloverCount, 1);
    assert.equal(day2.view.stats.carriedCount, 1);
    assert.equal(day2.rollover.days, 1);
    assert.equal(day2.rollover.moved, 1);
  });

  const day4 = await A.day('2026-10-15').get('today');
  check('隔两天再打开：一次补算 2 天，顺延累计到 3 天', () => {
    assert.equal(day4.view.todos[0].plannedDate, '2026-10-15');
    assert.equal(day4.view.todos[0].rolloverCount, 3);
    assert.equal(day4.rollover.days, 2);
  });

  check('顺延不产生新记录（todos 里仍然只有 1 条）', () => {
    assert.equal(A.readState().todos.length, 1);
  });

  check('顺延按天记账，供统计与报表使用', () => {
    const state = A.readState();
    assert.equal(state.rolloverLog['2026-10-12'], 1);
    assert.equal(state.rolloverLog['2026-10-13'], 1);
    assert.equal(state.rolloverLog['2026-10-14'], 1);
  });

  const done = await A.ok({ action: 'todo_complete', task: '订单导出', date: '2026-10-15' });
  check('完成任务只写事实流水，绝不碰工时台账', () => {
    const state = A.readState();
    const log = state.logs.find((item) => item.id === done.data.logId);
    assert.ok(log, '找不到流水');
    assert.equal(log.title, '订单导出接口重构');
    assert.equal(log.source, 'todo');
    assert.equal(log.rolloverCount, 3);
    assert.equal(log.voided, false);
    assert.equal(log.hours, 0, '流水不该承载工时');
    assert.equal(state.days['2026-10-15'], undefined, '完成待办不应产生任何工时记录');
  });

  const afterDone = await A.get('today');
  check('完成当天从待办移入已完成', () => {
    assert.equal(afterDone.view.todos.length, 0);
    assert.equal(afterDone.view.done.length, 1);
  });

  const undone = await A.ok({ action: 'todo_undo', task: '订单导出' });
  check('撤销完成：只作废事实流水，待办回到未完成', () => {
    const state = A.readState();
    const log = state.logs.find((item) => item.id === undone.data.logId);
    assert.equal(log.voided, true);
    assert.ok(log.voidedAt);
    const todo = state.todos.find((item) => item.id === todoId);
    assert.equal(todo.status, 'open');
    assert.equal(todo.plannedDate, '2026-10-15');
    assert.equal(todo.logId, null);
  });

  await checkAsync('撤销待办不牵动工时台账', async () => {
    const view = await A.get('hours', { month: '2026-10' });
    assert.equal(view.view.loggedHours, 0);
  });

  await A.ok({ action: 'todo_reschedule', task: '订单导出', deltaDays: 5 });
  check('reschedule 平移计划日', () => {
    assert.equal(A.readState().todos.find((item) => item.id === todoId).plannedDate, '2026-10-20');
  });

  await A.ok({ action: 'todo_reschedule', task: '订单导出', toBacklog: true });
  await checkAsync('转入积压后不再出现在今日列表', async () => {
    const view = await A.get('today');
    assert.equal(view.view.todos.length, 0);
    assert.equal(view.view.backlog.length, 1);
    assert.equal(view.view.backlog[0].title, '订单导出接口重构');
  });

  await A.ok({ action: 'todo_reschedule', task: '订单导出', toToday: true });
  await checkAsync('拉回今天', async () => {
    const view = await A.get('today');
    assert.equal(view.view.todos.length, 1);
    assert.equal(view.view.todos[0].plannedDate, '2026-10-15');
  });
}

/* ------------------------------------------------------------------ *
 * 3. 重复任务
 * ------------------------------------------------------------------ */

group('3. 重复任务（一律顺延 + 一次只留一个未完成实例）');
{
  await A.ok({ action: 'todo_create', title: '每日站会', repeat: { freq: 'workdays' }, estimateHours: 0.5 });

  const day1 = await A.get('today');
  check('重复任务模板建成后立刻开出当天实例（10-15 周四，工作日）', () => {
    const instances = day1.view.todos.filter((item) => item.title === '每日站会');
    assert.equal(instances.length, 1);
    assert.equal(instances[0].plannedDate, '2026-10-15');
  });

  await A.day('2026-10-19').get('today');
  check('未完成的重复任务实例顺延 4 天，且不会堆积成多条', () => {
    const instances = A.readState().todos.filter((item) => item.title === '每日站会' && !item.isTemplate);
    assert.equal(instances.length, 1, `实际 ${instances.length} 条`);
    assert.equal(instances[0].plannedDate, '2026-10-19');
    assert.equal(instances[0].rolloverCount, 4); // 10-16、17、18、19
  });

  check('周末不会开出新的实例', () => {
    const weekend = A.readState().todos.filter((item) => item.title === '每日站会' && item.plannedDate === '2026-10-17');
    assert.equal(weekend.length, 0);
  });

  const instancesNow = A.readState().todos.filter((item) => item.title === '每日站会' && !item.isTemplate);
  await A.ok({ action: 'todo_complete', id: instancesNow[0].id, date: '2026-10-19' });
  await A.day('2026-10-20');
  const day4 = await A.get('today');
  check('完成今天这一条后，次日开出全新的实例', () => {
    const open = day4.view.todos.filter((item) => item.title === '每日站会');
    assert.equal(open.length, 1);
    assert.equal(open[0].plannedDate, '2026-10-20');
    assert.equal(open[0].rolloverCount, 0);
  });

  check('模板本身不参与顺延、不出现在今日列表', () => {
    const templates = A.readState().todos.filter((item) => item.isTemplate);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].plannedDate, null);
    assert.equal(templates[0].repeat.freq, 'workdays');
  });

  const disabled = await A.ok({ action: 'todo_update', task: '每日站会', enabled: false, id: A.readState().todos.find((t) => t.isTemplate).id });
  check('停用重复任务模板会收掉未完成的实例', () => {
    assert.match(disabled.message, /停用/);
    const state = A.readState();
    assert.equal(state.todos.find((t) => t.isTemplate).archived, true);
    assert.equal(state.todos.filter((t) => t.templateId && t.status === 'open').length, 0);
  });
}

/* ------------------------------------------------------------------ *
 * 4. 工时管理
 * ------------------------------------------------------------------ */

const B = await harness('hours');

group('4. 工时管理（法定硬口径：请假不扣、按月不结转）');
{
  const month0 = await B.get('hours', { month: '2026-10' });
  check('10 月：18 个法定工作日 → 计划 135h → 必须 148.5h', () => {
    assert.equal(month0.view.workdays, 18);
    assert.equal(month0.view.planHours, 135);
    assert.equal(month0.view.requiredHours, 148.5);
    assert.equal(month0.view.gradeFactor, 1.1);
    assert.equal(month0.view.gradeLabel, '标准');
  });

  check('已过工作日 3 天（10-08/09/10），剩余 15 天（含今天）', () => {
    assert.equal(month0.view.elapsedWorkdays, 3);
    assert.equal(month0.view.remainingWorkdays, 15);
    assert.equal(month0.view.idealHours, 24.75);
    assert.equal(month0.view.paceDelta, -24.75);
  });

  check('日需工时 = 缺口 / 剩余工作日，超过 7.5h 时告警', () => {
    assert.equal(month0.view.gapHours, 148.5);
    assert.equal(month0.view.needPerDay, 9.9);
    assert.equal(month0.view.needPerDayOver, true);
  });

  // 工时只能由工单产生：这三笔都是「工单」
  const t1 = await B.ok({ action: 'ticket_add', date: '2026-10-08', hours: 7.5, title: '需求评审 + 编码' });
  const t2 = await B.ok({ action: 'ticket_add', date: '2026-10-09', hours: 6, title: '编码' });
  const project = await B.ok({ action: 'project_create', name: '订单中台', emoji: '📦' });
  await B.ok({ action: 'ticket_add', date: '2026-10-10', hours: 8, project: '订单中台', title: '调休上班' });

  const month1 = await B.get('hours', { month: '2026-10' });
  check('录入 21.5h 后达成率与缺口正确', () => {
    assert.equal(month1.view.loggedHours, 21.5);
    assert.equal(month1.view.gapHours, 127);
    assert.equal(month1.view.achievement, 14.5);
    assert.equal(month1.view.paceDelta, -3.25);
  });

  check('按项目分布正确（8h 归到订单中台，13.5h 未归类）', () => {
    assert.equal(month1.view.byProject.find((item) => item.projectId === project.data.id).hours, 8);
    assert.equal(month1.view.byProject.find((item) => item.projectId === null).hours, 13.5);
  });

  check('10-10 调休上班投入 8h → 加班 0.5h', () => {
    assert.equal(month1.view.overtimeHours, 0.5);
  });

  check('月历把 10-10 标成调休上班、10-01 标成国庆节', () => {
    const cell = month1.view.days.find((item) => item.key === '2026-10-10');
    assert.equal(cell.kind, 'adjusted-workday');
    assert.equal(cell.met, true);
    const national = month1.view.days.find((item) => item.key === '2026-10-01');
    assert.equal(national.kind, 'holiday');
    assert.equal(national.holiday, '国庆节');
  });

  await checkAsync('删除工单会把它带的小时一起收回', async () => {
    await B.ok({ action: 'ticket_remove', id: t2.data.id });
    const view = await B.get('hours', { month: '2026-10' });
    assert.equal(view.view.loggedHours, 15.5);
  });

  await checkAsync('改工单小时数，台账跟着变（不会叠加）', async () => {
    await B.ok({ action: 'ticket_update', id: t1.data.id, hours: 9.5 });
    const view = await B.get('hours', { month: '2026-10' });
    assert.equal(view.view.loggedHours, 17.5);
    assert.equal(view.view.days.find((item) => item.key === '2026-10-08').hours, 9.5);
  });

  await B.ok({ action: 'hours_mark', date: '2026-10-13', status: 'leave', note: '年假' });
  await checkAsync('请假在法定硬口径下不扣减必须工时，只单独统计', async () => {
    const view = await B.get('hours', { month: '2026-10' });
    assert.equal(view.view.leaveDays, 1);
    assert.equal(view.view.requiredHours, 148.5);
    assert.equal(view.view.days.find((item) => item.key === '2026-10-13').status, 'leave');
  });

  await checkAsync('已结束的月份：剩余工作日 0，日需工时为 null', async () => {
    const view = await B.get('hours', { month: '2026-09' });
    assert.equal(view.view.remainingWorkdays, 0);
    assert.equal(view.view.needPerDay, null);
    assert.equal(view.view.settled, true);
    assert.equal(view.view.workdays, 22);
    assert.equal(view.view.trend.length, 6);
    assert.equal(view.view.trend[5].month, '2026-09');
  });

  await checkAsync('未来月份不虚报达成率', async () => {
    const view = await B.get('hours', { month: '2026-12' });
    assert.equal(view.view.loggedHours, 0);
    assert.equal(view.view.achievement, 0);
    assert.equal(view.view.isFutureMonth, true);
  });
}

/* ------------------------------------------------------------------ *
 * 5. 报表（时间维度 / 项目维度 / 归档）
 * ------------------------------------------------------------------ */

const C = await harness('reports');
const C_PROJECT = { order: null, recon: null };

group('5. 周报 / 月报 / 年报 与历史归档');
{
  C_PROJECT.order = (await C.ok({ action: 'project_create', name: '订单中台', code: 'OMS', emoji: '📦', owner: '我' })).data.id;
  C_PROJECT.recon = (await C.ok({ action: 'project_create', name: '对账系统', code: 'REC', emoji: '🧾' })).data.id;

  await C.ok({ action: 'todo_create', title: '订单导出接口重构', project: '订单中台', plannedDate: '2026-10-05', estimateHours: 8 });
  await C.ok({ action: 'todo_create', title: '支付回调幂等性改造', project: '订单中台', plannedDate: '2026-10-06', estimateHours: 6 });
  await C.ok({ action: 'todo_create', title: '对账系统灰度方案设计', project: '对账系统', plannedDate: '2026-10-07', estimateHours: 6 });

  await C.ok({ action: 'todo_complete', task: '订单导出接口重构', date: '2026-10-05', note: 'QPS 从 120 提到 900' });
  await C.ok({ action: 'todo_complete', task: '支付回调幂等性改造', date: '2026-10-06' });
  await C.ok({ action: 'log_note', title: '与产品对齐导出字段', date: '2026-10-07', project: '订单中台' });
  // 工时是另一套台账：这几笔与上面的待办没有任何关联
  await C.ok({ action: 'ticket_add', date: '2026-10-08', hours: 7.5, project: '订单中台', title: '联调' });
  await C.ok({ action: 'ticket_add', date: '2026-10-09', hours: 7.5, title: '写文档' });

  // 锚点为 10-09（周五）：周报写的是「上周五 ~ 本周四」= 10-02 ~ 10-08
  const weekly = await C.ok({ action: 'report_create', type: 'weekly', date: '2026-10-09' });
  const reportId = weekly.data.id;
  const report = weekly.data.report;

  check('周报默认是「上周五 ~ 本周四」：锚点 10-09 对应 10-02 ~ 10-08', () => {
    assert.equal(report.from, '2026-10-02', '起点应当是上周五');
    assert.equal(report.to, '2026-10-08', '终点应当是本周四');
    assert.equal(dayCount(report.from, report.to), 7, '默认一周 7 天');
    assert.match(report.title, /W40/);
  });

  await checkAsync('周五写周报，落到刚过完的那一周（上周五 ~ 本周四）', async () => {
    // 今天是 10-23（周五）→ 应当是 10-16 ~ 10-22，而不是未来的 10-23 ~ 10-29
    const friday = await C.ok({ action: 'report_create', type: 'weekly', date: '2026-10-23' });
    assert.equal(friday.data.report.from, '2026-10-16');
    assert.equal(friday.data.report.to, '2026-10-22');
    // 同一天之后的周一到周日，都还指向这一周（写晚几天也不跑偏）
    for (const day of ['2026-10-22', '2026-10-26', '2026-10-25']) {
      const same = await C.ok({ action: 'report_create', type: 'weekly', date: day });
      assert.equal(same.data.report.from, '2026-10-16', `${day} 应当还是 10-16 起`);
      assert.equal(same.data.report.to, '2026-10-22', `${day} 应当还是 10-22 止`);
    }
  });

  await checkAsync('周报可以自定义区间（from / to 优先于 date）', async () => {
    const custom = await C.ok({ action: 'report_create', type: 'weekly', date: '2026-10-09', from: '2026-10-01', to: '2026-10-03' });
    assert.equal(custom.data.report.from, '2026-10-01');
    assert.equal(custom.data.report.to, '2026-10-03');
    assert.equal(dayCount(custom.data.report.from, custom.data.report.to), 3);
    assert.equal(custom.data.report.title, '周报 · 10-01 ~ 10-03', `自定义区间的标题应当是日期：${custom.data.report.title}`);
    // 反着传也能纠正过来
    const reversed = await C.ok({ action: 'report_create', type: 'weekly', from: '2026-10-03', to: '2026-10-01' });
    assert.equal(reversed.data.report.from, '2026-10-01');
    assert.equal(reversed.data.report.to, '2026-10-03');
  });

  check('周报按公司模板：本周完成 + 项目分组 + 下周待办', () => {
    assert.ok(report.content.startsWith('本周完成：\n【'), `开头不对：${JSON.stringify(report.content.slice(0, 40))}`);
    assert.ok(report.content.includes('【订单中台】'), '缺少项目分段');
    assert.match(report.content, /^1\.订单导出接口重构（100%）$/m);
    assert.match(report.content, /^2\.支付回调幂等性改造（100%）$/m);
    assert.ok(report.content.includes('下周待办：'), '缺少下周待办');
    // 未完成的那条：本周完成里按 30% 出现，同时进下周待办（不带百分比）
    assert.match(report.content, /^1\.对账系统灰度方案设计（30%）$/m);
    assert.match(report.content, /^1\.对账系统灰度方案设计$/m);
    // 周报不再有 Markdown 标题、工时、备注正文
    assert.ok(!/^#/m.test(report.content), '周报不该有 Markdown 标题');
    assert.ok(!report.content.includes('工时'), '周报不该出现工时');
    assert.ok(!report.content.includes('QPS 从 120 提到 900'), '周报不展开备注');
  });

  check('区间内只有 10-08 一个法定工作日（10-02~07 全是国庆假期）', () => {
    assert.equal(report.facts.legs.workdays, 1);
    assert.equal(report.facts.legs.planHours, 7.5);
    assert.equal(report.facts.legs.requiredHours, 8.25);
  });

  check('facts 冻结完成数与项目分组（完成数来自流水，工时来自工时台账）', () => {
    assert.equal(report.facts.totals.done, 3);
    assert.equal(report.facts.meta.dimension, 'time');
    const order = report.facts.byProject.find((group) => group.name === '订单中台');
    assert.ok(order, '缺少订单中台分组');
    assert.equal(order.done, 3);
    assert.equal(order.hours, 7.5, '项目工时应当只统计挂在该项目上的工时条目');
    assert.ok(order.highlights.some((line) => /QPS 从 120 提到 900/.test(line)));
  });

  check('报表里的工时口径来自 days，不是流水里的 hours', () => {
    // 区间是 10-02~10-08，只有 10-08 那张 7.5h 的工单落进来
    assert.equal(report.facts.legs.loggedHours, 7.5);
    assert.equal(report.facts.totals.hours, 7.5);
    assert.ok(report.facts.completed.every((item) => item.hours === 0), '流水不该带工时');
  });

  check('未完成的待办在 facts 里仍按「未完成 / 顺延」口径统计（周报正文走精简口径）', () => {
    assert.equal(report.facts.carriedOver.length, 1);
    assert.equal(report.facts.carriedOver[0].title, '对账系统灰度方案设计');
    assert.equal(report.facts.nextWeek.length, 1);
    assert.equal(report.facts.nextWeek[0].title, '对账系统灰度方案设计');
  });

  check('周报带出下期计划', () => {
    assert.ok(report.facts.next);
    assert.equal(report.facts.next.from, '2026-10-09');
    assert.equal(report.facts.next.to, '2026-10-15', '下一期还是周五 ~ 周四');
    assert.ok(report.facts.next.planned.some((item) => item.title === '对账系统灰度方案设计'));
  });

  const projectReport = await C.ok({ action: 'report_create', type: 'project', project: '订单中台', date: '2026-10-05' });
  check('项目维度报表只收录该项目的事，并带项目概况', () => {
    const content = projectReport.data.report.content;
    assert.equal(projectReport.data.report.dimension, 'project');
    assert.match(content, /项目概况/);
    assert.match(content, /订单中台/);
    assert.match(content, /支付回调幂等性改造/);
    assert.doesNotMatch(content, /对账系统灰度方案设计/);
  });

  const yearly = await C.ok({ action: 'report_create', type: 'yearly', date: '2026-10-05' });
  check('年报覆盖全年', () => {
    assert.equal(yearly.data.report.from, '2026-01-01');
    assert.equal(yearly.data.report.to, '2026-12-31');
    assert.match(yearly.data.report.title, /2026 年/);
  });

  // ── 归档 ──
  await C.ok({ action: 'report_archive', id: reportId });
  const frozen = await C.get('report', { id: reportId });
  check('归档后状态、时间戳与只读标记正确', () => {
    assert.equal(frozen.view.status, 'archived');
    assert.ok(frozen.view.archivedAt);
    assert.equal(frozen.view.editable, false);
  });

  const saveArchived = await C.post({ action: 'report_save', id: reportId, content: '篡改' });
  check('归档后拒绝修改', () => {
    assert.equal(saveArchived.json.result.ok, false);
    assert.match(saveArchived.json.result.error, /归档/);
  });

  const deleteArchived = await C.post({ action: 'report_delete', id: reportId });
  check('归档后拒绝删除', () => {
    assert.equal(deleteArchived.json.result.ok, false);
  });

  const contentBefore = (await C.get('report', { id: reportId })).view.content;
  await C.ok({ action: 'todo_complete', task: '对账系统灰度方案设计', date: '2026-10-07' });
  await C.ok({ action: 'ticket_add', date: '2026-10-12', hours: 7.5, title: '补录' });
  const contentAfter = (await C.get('report', { id: reportId })).view.content;
  check('归档之后补录工时，历史报表内容一字不变', () => {
    assert.equal(contentAfter, contentBefore);
  });

  await checkAsync('实时重算的月报能看到补录的内容（冻结的只是已归档的那份）', async () => {
    const monthly = await C.ok({ action: 'report_create', type: 'monthly', date: '2026-10-05' });
    assert.match(monthly.data.report.content, /对账系统灰度方案设计/);
    assert.equal(monthly.data.report.facts.totals.done, 4);
    assert.equal(monthly.data.report.facts.legs.loggedHours, 22.5);
  });

  await checkAsync('补生成的历史周报不会被「后来做完了」改写', async () => {
    const late = await C.ok({ action: 'report_create', type: 'weekly', date: '2026-10-09' });
    // 10-07 完成的这条，在 10-11 结束时其实已经了结，所以不该再算「本期未完成」
    assert.equal(late.data.report.facts.carriedOver.length, 0);
  });

  const revised = await C.ok({ action: 'report_revise', id: reportId });
  check('修订生成 v2 草稿并指回上一版', () => {
    assert.equal(revised.data.report.revision, 2);
    assert.equal(revised.data.report.status, 'draft');
    assert.equal(revised.data.report.supersedes, reportId);
    assert.equal(revised.data.report.content, contentBefore);
  });

  await C.ok({ action: 'report_archive', id: projectReport.data.id });
  await C.ok({ action: 'report_archive', id: revised.data.id });
  const list = await C.get('reports', { status: 'all' });
  check('报表检索与三态计数', () => {
    assert.ok(list.view.total >= 5);
    assert.ok(list.view.counts.archived >= 3);
    assert.ok(list.view.reports[0].from >= list.view.reports[list.view.reports.length - 1].from);
    assert.ok(list.view.reports.every((item) => typeof item.excerpt === 'string'));
  });

  await C.day('2026-11-01');
  const drafted = await C.ok({ action: 'report_create', type: 'monthly', date: '2026-10-05' });
  const stale = await C.ok({ action: 'report_archive_stale' });
  check('一键归档所有区间已结束的草稿', () => {
    assert.ok(stale.data.count >= 1);
    assert.ok(stale.data.ids.includes(drafted.data.id));
  });

  const filtered = await C.get('reports', { projectId: C_PROJECT.order, status: 'all' });
  check('按项目过滤报表', () => {
    assert.ok(filtered.view.total >= 1);
    assert.ok(filtered.view.reports.every((item) => item.projectId === C_PROJECT.order));
  });
  await checkAsync('按没有报表的项目过滤 → 0 份', async () => {
    const empty = await C.get('reports', { projectId: C_PROJECT.recon, status: 'all' });
    assert.equal(empty.view.total, 0);
  });
}

/* ------------------------------------------------------------------ *
 * 6. 统计
 * ------------------------------------------------------------------ */

group('6. 统计（日 / 月 / 年）');
{
  const monthly = await C.get('stats', { dim: 'month', from: '2026-01-01', to: '2026-12-31' });
  check('按月给出 12 个桶', () => {
    assert.equal(monthly.view.buckets.length, 12);
    assert.equal(monthly.view.buckets[9].key, '2026-10');
  });

  check('10 月桶的完成数（来自流水）与工时（来自工时台账）各自独立', () => {
    const october = monthly.view.buckets.find((item) => item.key === '2026-10');
    assert.equal(october.done, 4);
    assert.equal(october.hours, 22.5);
    assert.ok(october.completionRate > 0);
  });

  check('全年区间给出法定工作日与必须工时', () => {
    assert.equal(monthly.view.legs.workdays, 248);
    assert.equal(monthly.view.legs.planHours, 1860);
    assert.equal(monthly.view.legs.requiredHours, 2046);
  });

  const daily = await C.get('stats', { dim: 'day', from: '2026-10-05', to: '2026-10-11' });
  check('按天给出 7 个桶，10-05 与 10-06 各完成 1 项', () => {
    assert.equal(daily.view.buckets.length, 7);
    assert.equal(daily.view.buckets[0].key, '2026-10-05');
    assert.equal(daily.view.buckets[0].done, 1);
    assert.equal(daily.view.buckets[1].done, 1);
    assert.equal(daily.view.buckets[2].done, 2);
  });

  const yearly = await C.get('stats', { dim: 'year', from: '2026-01-01', to: '2026-12-31', heatmap: '1' });
  check('按年给出 1 个桶与热力图', () => {
    assert.equal(yearly.view.buckets.length, 1);
    assert.ok(Array.isArray(yearly.view.heatmap));
    assert.equal(yearly.view.heatmap.length, 365);
    assert.ok(yearly.view.heatmap.every((cell) => typeof cell.level === 'number' && cell.weekday >= 0 && cell.weekday <= 6));
  });

  const scoped = await C.get('stats', { dim: 'month', from: '2026-10-01', to: '2026-10-31', projectId: C_PROJECT.recon });
  check('按项目过滤统计：对账系统完成了 1 项，但工时台账里没有它的工时', () => {
    assert.equal(scoped.view.totals.done, 1);
    assert.equal(scoped.view.totals.hours, 0);
  });

  const reversed = await C.get('stats', { dim: 'month', from: '2026-12-31', to: '2026-01-01' });
  check('区间颠倒时自动纠正而不是报错', () => {
    assert.equal(reversed.view.from, '2026-01-01');
    assert.equal(reversed.view.to, '2026-12-31');
    assert.equal(reversed.view.buckets.length, 12);
  });
}

/* ------------------------------------------------------------------ *
 * 7. Agent 工具
 * ------------------------------------------------------------------ */

group('7. Agent 工具（workbench_todo / workbench_hours / workbench_report）');
{
  const D = await harness('tools');

  check('三个工具都已注册', () => {
    assert.ok(D.tools.has('workbench_todo'));
    assert.ok(D.tools.has('workbench_hours'));
    assert.ok(D.tools.has('workbench_report'));
  });

  const missingProject = await D.tool('workbench_todo', { action: 'add', title: '写单元测试', project: '不存在的项目', date: '2026-10-12' });
  check('引用不存在的项目时给出明确错误而不是静默丢弃', () => {
    assert.match(missingProject, /❌ 找不到项目/);
  });

  await D.tool('workbench_todo', { action: 'project_add', title: '订单中台', emoji: '📦', code: 'OMS', date: '2026-10-12' });
  const addOut = await D.tool('workbench_todo', { action: 'add', title: '写单元测试', project: '订单中台', priority: 'P1', date: '2026-10-12' });
  check('workbench_todo add 建立待办', () => {
    assert.match(addOut, /已新建待办/);
  });

  const todayOut = await D.tool('workbench_todo', { action: 'today', date: '2026-10-12' });
  check('workbench_todo today 输出今日战报', () => {
    assert.match(todayOut, /📅 2026-10-12/);
    assert.match(todayOut, /写单元测试/);
    assert.match(todayOut, /法定工作日/);
  });

  const completeOut = await D.tool('workbench_todo', { action: 'complete', task: '单元测试', date: '2026-10-12' });
  check('workbench_todo complete 支持标题部分匹配，且不产生任何工时', () => {
    assert.match(completeOut, /✅ 完成/);
    assert.doesNotMatch(completeOut, /今日工时/);
  });

  await D.tool('workbench_hours', { action: 'ticket_add', date: '2026-10-12', hours: 3, title: '写单元测试' });
  const afterLog = await D.tool('workbench_hours', { action: 'month', month: '2026-10', date: '2026-10-12' });
  check('工单是记工时的唯一方式，记完当月就有 3h', () => {
    assert.match(afterLog, /3h/);
    assert.match(afterLog, /写单元测试/, '月度总览里应当能看到这张工单');
  });

  const listOut = await D.tool('workbench_todo', { action: 'list', status: 'done', date: '2026-10-12' });
  check('workbench_todo list 可按状态过滤', () => {
    assert.match(listOut, /写单元测试/);
  });

  const hoursOut = await D.tool('workbench_hours', { action: 'month', month: '2026-10', date: '2026-10-12' });
  check('workbench_hours month 输出计划 / 必须 / 已录 / 日需工时', () => {
    assert.match(hoursOut, /必须工时/);
    assert.match(hoursOut, /148\.5h/);
    assert.match(hoursOut, /日需工时/);
    assert.match(hoursOut, /标准/);
  });

  const calendarOut = await D.tool('workbench_hours', { action: 'calendar', month: '2026-10', date: '2026-10-12' });
  check('workbench_hours calendar 输出月历与图例', () => {
    assert.match(calendarOut, /图例/);
    assert.match(calendarOut, /调/);
  });

  const dayOut = await D.tool('workbench_hours', { action: 'day', date: '2026-10-12' });
  check('workbench_hours day 输出当天明细', () => {
    assert.match(dayOut, /2026-10-12/);
    assert.match(dayOut, /3h/);
  });

  const trendOut = await D.tool('workbench_hours', { action: 'trend', months: 3, date: '2026-10-12' });
  check('workbench_hours trend 输出达成率趋势', () => {
    assert.match(trendOut, /达成/);
  });

  // 锚点 10-16（周五）→ 区间 10-09 ~ 10-15，正好兜住 10-12 那些活
  const draftOut = await D.tool('workbench_report', { action: 'draft', type: 'weekly', date: '2026-10-16' });
  check('workbench_report draft 同时给出结构化 facts 与草稿', () => {
    assert.match(draftOut, /结构化事实/);
    assert.match(draftOut, /reportId: rp_/);
    assert.match(draftOut, /写单元测试/);
  });

  const reportId = draftOut.match(/reportId: (rp_\w+)/)?.[1];
  assert.ok(reportId, '未能从 draft 输出里解析 reportId');

  const saveOut = await D.tool('workbench_report', {
    action: 'save',
    id: reportId,
    content: '# 我润色过的周报\n\n本周完成了单元测试。',
  });
  check('workbench_report save 写回润色后的正文', () => {
    assert.match(saveOut, /已保存/);
  });

  const getOut = await D.tool('workbench_report', { action: 'get', id: reportId });
  check('写回的正文可原样读回', () => {
    assert.match(getOut, /我润色过的周报/);
  });

  const finalizeOut = await D.tool('workbench_report', { action: 'finalize', id: reportId });
  check('workbench_report finalize 定稿', () => {
    assert.match(finalizeOut, /已定稿/);
  });

  const archiveOut = await D.tool('workbench_report', { action: 'archive', id: reportId });
  check('workbench_report archive 归档并冻结', () => {
    assert.match(archiveOut, /已归档/);
    assert.match(archiveOut, /只读|已归档/);
  });

  const statsOut = await D.tool('workbench_report', { action: 'stats', dim: 'month', from: '2026-10-01', to: '2026-10-31', date: '2026-10-12' });
  check('workbench_report stats 输出统计表', () => {
    assert.match(statsOut, /📈 统计/);
    assert.match(statsOut, /完成率/);
  });

  const listOut2 = await D.tool('workbench_report', { action: 'list', date: '2026-10-12' });
  check('workbench_report list 列出报表', () => {
    assert.match(listOut2, /报表共/);
  });

  const staleOut = await D.tool('workbench_report', { action: 'archive_stale', date: '2026-10-12' });
  check('workbench_report archive_stale 可用', () => {
    assert.match(staleOut, /过期草稿|已归档/);
  });
}

/* ------------------------------------------------------------------ *
 * 8. 设置、节假日覆盖与协议边界
 * ------------------------------------------------------------------ */

const E = await harness('settings', {
  dailyHours: 7.5,
  grade: 'senior',
  gradeLabel: '测试职级',
  gradeFactor: 1.1,
});

group('8. 设置、节假日覆盖与协议边界');
{
  const boot = await E.get('bootstrap');
  check('行 config 种入默认值并标记已 seeding', () => {
    assert.equal(boot.view.settings.dailyHours, 7.5);
    assert.equal(boot.view.settings.gradeFactor, 1.1);
    assert.equal(boot.view.settings.gradeLabel, '测试职级');
    assert.equal(E.readState().meta.seeded, true);
  });

  await checkAsync('重启后不被行 config 覆盖用户设置（seeded 保留）', async () => {
    const restarted = await harness('settings', { dailyHours: 1, gradeFactor: 2, gradeLabel: '不该出现' });
    const boot2 = await restarted.get('bootstrap');
    assert.equal(boot2.view.settings.dailyHours, 7.5);
    assert.equal(boot2.view.settings.gradeFactor, 1.1);
    assert.equal(boot2.view.settings.gradeLabel, '测试职级');
  });

  await checkAsync('自定义报表模板覆盖周报内置版式', async () => {
    await E.ok({ action: 'settings_update', settings: { reportTemplate: '我的周报：{{title}}\n{{weeklyCompleted}}\n下周：{{nextWeek}}' } });
    const boot2 = await E.get('bootstrap');
    assert.match(boot2.view.settings.reportTemplate, /我的周报/);
    const created = await E.ok({ action: 'report_create', type: 'weekly', date: '2026-10-22' });
    assert.match(created.data.report.content, /^我的周报：/);
    assert.match(created.data.report.content, /下周：/);
    await E.ok({ action: 'settings_update', settings: { reportTemplate: '' } });
  });

  await E.ok({ action: 'settings_update', settings: { dailyHours: 8, gradeFactor: 1.2 } });
  await checkAsync('设置更新后工时公式跟着走：18 × 8 = 144 → 必须 172.8', async () => {
    const view = await E.get('hours', { month: '2026-10' });
    assert.equal(view.view.planHours, 144);
    assert.equal(view.view.requiredHours, 172.8);
    assert.equal(view.view.dailyHours, 8);
  });

  await E.ok({ action: 'settings_update', settings: { dailyHours: 7.5, gradeFactor: 1.1 } });

  await E.ok({ action: 'holiday_override_set', date: '2026-10-13', kind: 'holiday' });
  await checkAsync('手工把 10-13 标为放假日 → 全月工作日少一天', async () => {
    const view = await E.get('hours', { month: '2026-10' });
    assert.equal(view.view.workdays, 17);
    assert.equal(view.view.days.find((item) => item.key === '2026-10-13').kind, 'holiday');
  });

  await E.ok({ action: 'holiday_override_clear', date: '2026-10-13' });
  await checkAsync('取消覆盖后恢复 18 天', async () => {
    assert.equal((await E.get('hours', { month: '2026-10' })).view.workdays, 18);
  });

  await checkAsync('2027 年数据未导入时明确告警而不是静默估算', async () => {
    const view = await E.get('hours', { month: '2027-03' });
    assert.equal(view.view.coverage.complete, false);
    assert.deepEqual(view.view.coverage.uncoveredYears, ['2027']);
    assert.equal(view.view.workdays, 23); // 2027-03 周一~周五
  });

  await E.day('2026-10-01');
  await checkAsync('系统时钟回拨时不撤销已发生的顺延，也不回退游标', async () => {
    const view = await E.get('today');
    assert.equal(view.view.date, '2026-10-01');
    assert.ok(E.readState().cursor.rolledThrough >= '2026-10-12');
  });

  const unknownAction = await E.post({ action: 'nope' });
  check('未知 action 返回 ok=false 而不是抛异常', () => {
    assert.equal(unknownAction.status, 200);
    assert.equal(unknownAction.json.result.ok, false);
    assert.match(unknownAction.json.result.error, /未知操作/);
  });

  const emptyPatch = await E.post({ action: 'settings_update' });
  check('空 patch 被拒绝', () => {
    assert.equal(emptyPatch.json.result.ok, false);
  });

  const badJson = await E.raw({ action: 'todo_create', title: 'x' });
  void badJson;
  const noAction = await E.raw({});
  check('缺少 action → 400', () => {
    assert.equal(noAction.status, 400);
    assert.equal(noAction.json.ok, false);
  });

  const wrongType = await E.rawTyped({ action: 'settings_update' }, 'text/plain');
  check('content-type 不是 JSON → 415', () => {
    assert.equal(wrongType.status, 415);
  });

  await checkAsync('未知 view 不影响业务结果，只回退到默认视图', async () => {
    const res = await E.raw({ action: 'settings_update', view: 'zzz', settings: { dailyHours: 7.6 } });
    assert.equal(res.json.result.ok, true);
    assert.ok(res.json.view);
  });
}

/* ------------------------------------------------------------------ *
 * 9. 顺延策略 backlog / never
 * ------------------------------------------------------------------ */

const F = await harness('policies');

group('9. 顺延策略 backlog / never');
{
  await F.ok({ action: 'todo_create', title: '每天背单词', plannedDate: '2026-10-12', rollover: 'backlog' });
  await F.ok({ action: 'todo_create', title: '今天必须交的日报', plannedDate: '2026-10-12', rollover: 'never' });

  await F.day('2026-10-14');
  const later = await F.get('today');
  check('backlog 策略：顺延进积压区，不占今日列表', () => {
    assert.equal(later.view.todos.length, 0);
    assert.equal(later.view.backlog.length, 1);
    assert.equal(later.view.backlog[0].title, '每天背单词');
    assert.equal(later.view.backlog[0].plannedDate, '2026-10-14');
  });

  const never = F.readState().todos.find((item) => item.title === '今天必须交的日报');
  check('never 策略：到期即作废并记下漏做日期', () => {
    assert.equal(never.status, 'dropped');
    assert.equal(never.dropReason, 'missed');
    assert.equal(never.missedDate, '2026-10-12');
  });

  await checkAsync('漏做被记入统计（planned = 完成 + 顺延 + 漏做 + 放弃）', async () => {
    const stats = await F.get('stats', { dim: 'day', from: '2026-10-12', to: '2026-10-14' });
    const first = stats.view.buckets[0];
    assert.equal(first.missed, 1);
    assert.equal(first.rolledOut, 1);
    assert.equal(first.planned, 2);
  });

  const restored = await F.ok({ action: 'todo_restore', task: '日报' });
  check('恢复被作废的待办，回到今天', () => {
    assert.equal(restored.data.id, never.id);
    const after = F.readState().todos.find((item) => item.id === never.id);
    assert.equal(after.status, 'open');
    assert.equal(after.plannedDate, '2026-10-14');
    assert.equal(after.missedDate, null);
  });

  await F.ok({ action: 'todo_drop', task: '每天背单词', reason: '需求取消' });
  await checkAsync('主动放弃与漏做在统计里分开计', async () => {
    // droppedAt 是真实时钟，所以区间要跟着它走，不能写死 10 月
    const droppedAt = F.readState().todos.find((item) => item.title === '每天背单词').droppedAt;
    const month = String(droppedAt).slice(0, 7);
    const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    const stats = await F.get('stats', { dim: 'month', from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` });
    const bucket = stats.view.buckets[0];
    assert.equal(bucket.dropped, 1, `放弃应当记进 ${month}`);
    assert.equal(bucket.missed, 0);
  });
}

/* ------------------------------------------------------------------ *
 * 10. 数据健壮性
 * ------------------------------------------------------------------ */

group('10. 脏数据与持久化健壮性');
{
  const G0 = await harness('dirty');
  await G0.ok({ action: 'todo_create', title: '正常待办' });
  const file = G0.stateFile;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  // 注入各种脏值
  raw.settings.dailyHours = 'abc';
  raw.settings.holidayOverrides = { '2026-10-13': 'nonsense', bad: 'holiday' };
  raw.todos.push({ id: 'broken', title: 123, priority: 'P9', rolloverCount: -5, plannedDate: 'not-a-date' });
  raw.days['2026-10-13'] = { status: 'weird', entries: 'nope' };
  raw.reports.push({ id: 'wrong', type: 'zzz', from: null });
  raw.rolloverLog = { '2026-10-13': 'x' };
  writeFileSync(file, JSON.stringify(raw));

  // 换一个插件实例重新读盘：插件自身对状态是懒加载 + 内存缓存的，
  // 直接改文件不会影响已经载入的实例（这正是我们要的持久化行为）。
  const G = await harness('dirty');

  await checkAsync('脏状态文件不致命：规范化后仍能正常服务', async () => {
    const view = await G.get('today');
    assert.equal(view.view.date, '2026-10-12');
    assert.equal(view.view.todos.length, 1);
  });

  check('脏值被夹紧或丢弃', () => {
    const state = G.readState();
    assert.equal(state.settings.dailyHours, 7.5);
    assert.deepEqual(state.settings.holidayOverrides, {});
    const broken = state.todos.find((item) => item.id === 'broken');
    assert.equal(broken.priority, 'P2');
    assert.equal(broken.rolloverCount, 0);
    assert.equal(broken.plannedDate, null);
    assert.equal(state.reports.find((item) => item.id === 'wrong').type, 'weekly');
    assert.equal(state.rolloverLog['2026-10-13'], 0);
  });

  await checkAsync('顺延游标丢失后重新对齐，不会把历史全部重放', async () => {
    const state = G.readState();
    assert.equal(state.cursor.rolledThrough, '2026-10-12');
  });
}

/* ------------------------------------------------------------------ *
 * 11. 项目引用的边界：空串不能被 `??` 短路吞掉
 * ------------------------------------------------------------------ */

const H = await harness('project-ref');

group('11. 项目引用解析（空串 projectId 不能吞掉 project 参数）');
{
  await H.ok({ action: 'project_create', name: '订单中台', code: 'OMS' });

  const created = await H.ok({
    action: 'todo_create',
    title: '带空串 projectId 的待办',
    projectId: '',
    project: '订单中台',
    plannedDate: '2026-10-12',
  });
  check('projectId 是空串时，仍然按 project 名称挂到项目上', () => {
    assert.ok(created.data.todo.projectId, 'projectId 为空 → 关联丢失');
    assert.equal(created.data.todo.projectId, H.readState().projects[0].id);
  });

  const logged = await H.ok({ action: 'ticket_add', date: '2026-10-12', hours: 3, title: '空串项目', projectId: '', project: '订单中台' });
  check('ticket_add 同样不被空串短路', () => {
    const state = H.readState();
    const entry = state.days['2026-10-12'].entries.find((item) => item.ticketId === logged.data.id);
    assert.ok(entry, '没找到这条工单写出的工时条目');
    assert.equal(entry.projectId, state.projects[0].id);
  });

  const noted = await H.ok({ action: 'log_note', title: '随手记', date: '2026-10-12', projectId: '', project: '订单中台' });
  check('log_note 同样不被空串短路', () => {
    const log = H.readState().logs.find((item) => item.id === noted.data.id);
    assert.equal(log.projectId, H.readState().projects[0].id);
  });

  const reported = await H.ok({ action: 'report_create', type: 'project', projectId: '', project: '订单中台', date: '2026-10-12' });
  check('report_create 同样不被空串短路', () => {
    assert.equal(reported.data.report.dimension, 'project');
    assert.equal(reported.data.report.projectId, H.readState().projects[0].id);
  });

  const bare = await H.ok({ action: 'todo_create', title: '不挂项目的待办', projectId: '', plannedDate: '2026-10-12' });
  check('只给空串（没给 project）时安静地当成「无项目」，不报错', () => {
    assert.equal(bare.data.todo.projectId, null);
  });

  const bad = await H.post({ action: 'todo_create', title: 'x', projectId: '', project: '不存在的项目' });
  check('给了错误的项目名仍然明确报错', () => {
    assert.equal(bad.json.result.ok, false);
    assert.match(bad.json.result.error, /找不到项目/);
  });
}

/* ------------------------------------------------------------------ *
 * 12. 待办与工时是两套台账
 * ------------------------------------------------------------------ */

const I = await harness('ledgers');

group('12. 待办与工时是两套台账（互不写入）');
{
  await I.ok({ action: 'project_create', name: '订单中台', emoji: '📦' });
  await I.ok({ action: 'todo_create', title: '写技术方案', project: '订单中台', plannedDate: '2026-10-12', estimateHours: 8 });

  await I.ok({ action: 'todo_complete', task: '写技术方案' });
  check('完成待办不会产生任何工时记录', () => {
    const state = I.readState();
    assert.deepEqual(Object.keys(state.days), []);
    assert.equal(state.logs.filter((item) => !item.voided).length, 1);
    assert.equal(state.logs[0].hours, 0, '流水不该承载工时');
  });

  await I.ok({ action: 'todo_undo', task: '写技术方案' });
  check('撤销待办同样不牵动工时台账', () => {
    assert.deepEqual(Object.keys(I.readState().days), []);
  });

  await I.ok({ action: 'log_note', title: '与产品对齐字段', date: '2026-10-12', project: '订单中台' });
  const logsBefore = I.readState().logs.filter((item) => !item.voided).length;

  await I.ok({ action: 'ticket_add', date: '2026-10-12', hours: 7.5, project: '订单中台', title: '一张工单' });
  check('记工时不会产生流水', () => {
    assert.equal(I.readState().logs.filter((item) => !item.voided).length, logsBefore);
  });

  await I.ok({ action: 'ticket_remove', id: I.readState().tickets[0].id });
  check('删工时不会作废流水', () => {
    assert.equal(I.readState().logs.filter((item) => !item.voided).length, logsBefore);
    assert.deepEqual(Object.keys(I.readState().days), []);
  });

  const noteOut = await I.ok({ action: 'log_note', title: '带 hours 的随手记', date: '2026-10-12', hours: 3 });
  check('随手记即使传了 hours 也不写进工时台账', () => {
    assert.deepEqual(Object.keys(I.readState().days), []);
    assert.equal(I.readState().logs.find((item) => item.id === noteOut.data.id).hours, 0);
  });

  check('待办的 schema 里已经不存在 actualHours', () => {
    assert.equal('actualHours' in I.readState().todos[0], false);
  });
}

/* ------------------------------------------------------------------ *
 * 14. 周报口径（公司模板）
 * ------------------------------------------------------------------ */

const K = await harness('weekly');

group('14. 周报草稿严格按公司模板输出');
{
  // 造出与真机示例一模一样的场景
  await K.ok({ action: 'project_create', name: '示例银行-村镇银行', emoji: '🏦' });
  await K.ok({ action: 'project_create', name: '示例政务客户', emoji: '🏛' });
  const mk = (title, project, date, progress) =>
    K.ok({ action: 'todo_create', title, project, plannedDate: date, progress });
  await mk('村镇银行生产定时短信无法处理问题修复', '示例银行-村镇银行', '2026-10-20', 30);
  const jdbc = (await mk('公共jdbc组件对接加密平台', '示例政务客户', '2026-10-19', 0)).data.id;
  const hist = (await mk('历史数据加解密工具对接加密平台', '示例政务客户', '2026-10-19', 0)).data.id;
  const sim = (await mk('加密平台模拟工具开发', '示例政务客户', '2026-10-20', 0)).data.id;
  await mk('加密功能自测', '示例政务客户', '2026-10-21', 10);
  await mk('文档编写', '示例政务客户', '2026-10-27', 0);
  await mk('架构评审', '示例银行-村镇银行', '2026-10-28', 0);
  for (const id of [jdbc, hist, sim]) await K.ok({ action: 'todo_complete', id, date: '2026-10-21' });

  const weekly = await K.ok({ action: 'report_create', type: 'weekly', date: '2026-10-22' });
  const content = weekly.data.report.content;

  check('本周完成：项目分组 + 编号 + 完成度，逐字符合模板', () => {
    assert.equal(
      content,
      [
        '本周完成：',
        '【示例银行-村镇银行】',
        '1.村镇银行生产定时短信无法处理问题修复（30%）',
        '【示例政务客户】',
        '1.公共jdbc组件对接加密平台（100%）',
        '2.历史数据加解密工具对接加密平台（100%）',
        '3.加密平台模拟工具开发（100%）',
        '4.加密功能自测（10%）',
        '下周待办：',
        '1.村镇银行生产定时短信无法处理问题修复',
        '2.加密功能自测',
        '3.文档编写',
        '4.架构评审',
      ].join('\n'),
    );
  });

  check('格式细节：半角「1.」、全角括号「（30%）」、组间不空行', () => {
    assert.match(content, /^本周完成：$/m);
    assert.match(content, /^【.+】$/m);
    assert.match(content, /^1\.[^\n]+（\d+%）$/m, '编号必须是半角句点且紧跟标题');
    assert.ok(!content.includes('\n\n'), '整份周报不该出现空行');
    assert.ok(!/^#/m.test(content), '不该有 Markdown 标题');
    assert.ok(!content.includes('工时'), '不该出现工时');
  });

  check('做完了就是 100%，没填进度的一律按 30%', () => {
    assert.ok(content.includes('公共jdbc组件对接加密平台（100%）'));
    // 只填了 10% 的保留 10%，没填的按 30%
    assert.ok(content.includes('加密功能自测（10%）'));
    assert.ok(content.includes('村镇银行生产定时短信无法处理问题修复（30%）'));
  });

  check('未完成的任务同时进入下周待办，且不带百分比', () => {
    const next = content.split('下周待办：')[1].split('\n').filter(Boolean);
    assert.deepEqual(next, [
      '1.村镇银行生产定时短信无法处理问题修复',
      '2.加密功能自测',
      '3.文档编写',
      '4.架构评审',
    ]);
  });

  check('组内按创建顺序，而不是按标题排序', () => {
    const block = content.split('【示例政务客户】')[1].split('下周待办：')[0].trim().split('\n');
    assert.deepEqual(block, [
      '1.公共jdbc组件对接加密平台（100%）',
      '2.历史数据加解密工具对接加密平台（100%）',
      '3.加密平台模拟工具开发（100%）',
      '4.加密功能自测（10%）',
    ]);
  });

  check('facts 冻结了周报口径的分组与下周待办', () => {
    const facts = weekly.data.report.facts;
    assert.equal(facts.weeklyGroups.length, 2);
    assert.equal(facts.weeklyGroups[0].name, '示例银行-村镇银行');
    assert.equal(facts.weeklyGroups[1].items.length, 4);
    assert.equal(facts.nextWeek.length, 4);
    assert.ok(facts.nextWeek.every((item) => typeof item.label === 'string' && !item.label.includes('%')));
  });

  await checkAsync('改过标题 / 换过项目的待办，生成的周报必须用最新信息', async () => {
    // ① 先按当时的名字完成一件、并生成一次周报
    const before = (await K.ok({ action: 'report_create', type: 'weekly', date: '2026-10-22' })).data.report;
    assert.ok(before.content.includes('公共jdbc组件对接加密平台（100%）'), '基线不对');

    // ② 已完成的那条：改标题 + 换项目
    const jdbcId = (await K.get('todos', { status: 'done' })).view.todos.find((item) => item.title === '公共jdbc组件对接加密平台').id;
    await K.ok({ action: 'todo_update', id: jdbcId, title: '公共jdbc组件对接加密平台（二期）', project: '示例银行-村镇银行' });

    // ③ 未完成的那条：也改标题
    const selfId = (await K.get('todos', { status: 'open' })).view.todos.find((item) => item.title === '加密功能自测').id;
    await K.ok({ action: 'todo_update', id: selfId, title: '加密功能自测（三轮）' });

    // ④ 重新生成
    const after = (await K.ok({ action: 'report_create', type: 'weekly', date: '2026-10-22' })).data.report;
    assert.match(after.content, /公共jdbc组件对接加密平台（二期）（100%）/, `已完成条目没跟上新标题：\n${after.content}`);
    assert.match(after.content, /加密功能自测（三轮）（10%）/, '未完成条目没跟上新标题');
    assert.ok(!after.content.includes('1.公共jdbc组件对接加密平台（100%）'), '还残留旧标题');

    // 换项目后应当落到新的项目段里
    const bankBlock = after.content.split('【示例银行-村镇银行】')[1].split('【')[0];
    assert.match(bankBlock, /公共jdbc组件对接加密平台（二期）/, `换项目后没进新分组：\n${after.content}`);

    // 下周待办也跟着用新标题
    const next = after.content.split('下周待办：')[1];
    assert.match(next, /加密功能自测（三轮）/, '下周待办还在用旧标题');
  });

  await checkAsync('月报 / 项目维度仍然用完整的叙述格式（不受周报口径影响）', async () => {
    const monthly = await K.ok({ action: 'report_create', type: 'monthly', date: '2026-10-22' });
    assert.match(monthly.data.report.content, /^# /m, '月报应当还有标题');
    assert.ok(monthly.data.report.content.includes('##'), '月报应当还有章节');
  });
}

/* ------------------------------------------------------------------ *
 * 15. 添加进周报文件
 * ------------------------------------------------------------------ */

const L = await harness('append');
const fsMod = await import('node:fs');
const pathMod = await import('node:path');
const osMod = await import('node:os');

group('15. 「添加进周报文件」插到文件开头');
{
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'aw-append-'));
  const mdFile = pathMod.join(dir, '周报.md');
  const txtFile = pathMod.join(dir, '周报.txt');
  fsMod.writeFileSync(
    mdFile,
    '#### 周报汇总\n\n#### 2026.09.07-2026.09.11 - 小组\n\n```\n【旧项目】\n1.旧事项（100%）\n```\n\n',
    'utf8',
  );
  fsMod.writeFileSync(txtFile, '2026.09.07-2026.09.11-小组\n【旧项目】\n1.旧事项（100%）\n', 'utf8');

  await L.ok({ action: 'project_create', name: '示例政务客户', emoji: '🏛' });
  const fund = (await L.ok({ action: 'todo_create', title: '公共jdbc组件对接加密平台', project: '示例政务客户', plannedDate: '2026-10-19' })).data.id;
  await L.ok({ action: 'todo_complete', id: fund, date: '2026-10-21' });
  await L.ok({ action: 'todo_create', title: '加密功能自测', project: '示例政务客户', plannedDate: '2026-10-21', progress: 10 });
  const weekly = (await L.ok({ action: 'report_create', type: 'weekly', date: '2026-10-22' })).data.report;

  const notReady = await L.post({ action: 'report_append_file', id: weekly.id });
  check('没配置周报文件时提示去设置里配，且没有写任何文件', () => {
    assert.equal(notReady.json.result.ok, false);
    assert.match(notReady.json.result.error, /设置/);
    assert.ok(fsMod.readFileSync(mdFile, 'utf8').includes('【旧项目】'), '原有内容不能被弄丢');
  });

  await checkAsync('设置里能存多个周报文件，并校验绝对路径与扩展名', async () => {
    const bad1 = await L.post({ action: 'settings_update', reportFiles: ['./相对.md'] });
    assert.equal(bad1.json.result.ok, false);
    assert.match(bad1.json.result.error, /绝对路径/);
    const bad2 = await L.post({ action: 'settings_update', reportFiles: ['/tmp/x.pdf'] });
    assert.equal(bad2.json.result.ok, false);
    assert.match(bad2.json.result.error, /\.md 或 \.txt/);
    const many = await L.ok({ action: 'settings_update', reportFiles: [mdFile, txtFile], reportSignature: '小组' });
    assert.equal(many.data.settings.reportFiles.length, 2);
    assert.equal(many.data.settings.reportSignature, '小组');
  });

  const appended = await L.ok({ action: 'report_append_file', id: weekly.id, path: mdFile });
  check('插到文件开头：新条目在标题之下、旧条目之上', () => {
    assert.match(appended.message, /开头/);
    const text = fsMod.readFileSync(mdFile, 'utf8');
    assert.match(text, /^#### 周报汇总\n\n#### 2026\.10\.16-2026\.10\.22 - 小组\n/, `开头结构不对：\n${text.slice(0, 160)}`);
    assert.ok(text.indexOf('2026.10.16-2026.10.22') < text.indexOf('2026.09.07-2026.09.11'), '新条目没排到旧条目之前');
    assert.ok(text.includes('【旧项目】'), '旧内容被弄丢了');
  });

  check('写进去的是代码块包住的正文，且不带多余的空白', () => {
    const text = fsMod.readFileSync(mdFile, 'utf8');
    const block = text.split('#### 2026.10.16-2026.10.22 - 小组')[1].split('#### 2026.09.07')[0];
    assert.match(block, /```\n本周完成：\n/, '正文应当包在代码块里');
    assert.match(block, /1\.公共jdbc组件对接加密平台（100%）/);
    assert.match(block, /2\.加密功能自测（10%）/);
    assert.match(block, /```\n\n$/, '代码块后面应当空一行');
  });

  const txt = await L.ok({ action: 'report_append_file', id: weekly.id, path: txtFile });
  check('.txt 用纯文本写法：日期行 + 正文，不要代码围栏', () => {
    assert.ok(txt.message.includes('周报.txt'));
    const text = fsMod.readFileSync(txtFile, 'utf8');
    assert.match(text, /^2026\.10\.16-2026\.10\.22-小组\n/, `txt 开头不对：\n${text.slice(0, 120)}`);
    assert.ok(!text.includes('```'), '.txt 不该出现代码围栏');
    assert.ok(text.indexOf('2026.10.16') < text.indexOf('2026.09.07'), 'txt 也要插到最前面');
  });

  await checkAsync('路径不合法时拒绝写入，文件保持原样', async () => {
    const before = fsMod.readFileSync(mdFile, 'utf8');
    for (const bad of ['/tmp/aw-绝对不存在/x.md', 'relative.md', '/tmp/aw-nope/x.pdf']) {
      const res = await L.post({ action: 'report_append_file', id: weekly.id, path: bad });
      assert.equal(res.json.result.ok, false, `${bad} 应当被拒绝`);
    }
    assert.equal(fsMod.readFileSync(mdFile, 'utf8'), before, '失败时不能改动文件');
  });

  fsMod.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 16. 工单
 * ------------------------------------------------------------------ */

const M = await harness('tickets');

group('16. 工单：录入 / 与工时台账只对一次账');
{
  await M.ok({ action: 'project_create', name: '示例银行', emoji: '🏦' });
  await M.ok({ action: 'project_create', name: '示例政务客户二期', emoji: '🏛' });

  const noHours = await M.ok({
    action: 'ticket_add',
    title: '密评整改相关优化',
    project: '示例政务客户二期',
    url: 'https://issuetrack.example.com/issues/10001',
    date: '2026-10-09',
    hours: null,
  });
  check('无工时的工单：照常入库，但不产生工时条目', () => {
    assert.match(noHours.message, /无工时/);
    const state = M.readState();
    assert.equal(state.tickets.length, 1);
    assert.equal(state.tickets[0].url, 'https://issuetrack.example.com/issues/10001');
    assert.equal(state.days['2026-10-09'], undefined, '无工时不该产生工时记录');
  });

  const withHours = await M.ok({
    action: 'ticket_add',
    title: '排障 #10002联通',
    project: '示例银行',
    url: 'https://issuetrack.example.com/issues/10002',
    date: '2026-10-14',
    hours: 17,
  });
  check('带工时的工单：同时写进工时台账，且带 ticketId 关联', () => {
    const state = M.readState();
    const day = state.days['2026-10-14'];
    assert.ok(day, '没写进工时台账');
    assert.equal(day.entries.length, 1);
    assert.equal(day.entries[0].hours, 17);
    assert.equal(day.entries[0].ticketId, withHours.data.id, '条目必须能认回工单');
    assert.equal(day.entries[0].note, '排障 #10002联通');
  });

  const noted = await M.ok({
    action: 'ticket_add',
    title: '修改发送接口变量空字符串校验',
    project: '示例银行',
    url: 'https://issuetrack.example.com/issues/10003',
    date: '2026-10-16',
    hours: 1,
    note: '不改',
    type: '任务',
  });

  await checkAsync('工单类型：任意短文字可用，非文字被拒绝', async () => {
    const view = await M.get('hours', { month: '2026-10' });
    const noted2 = view.view.tickets.find((item) => item.title === '修改发送接口变量空字符串校验');
    assert.equal(noted2.type, '任务');
    const first = view.view.tickets.find((item) => item.title === '密评整改相关优化');
    assert.equal(first.type, '', '没给类型时是空串，不是 undefined');

    const bad = await M.post({ action: 'ticket_add', title: '类型不对', type: 123 });
    assert.equal(bad.json.result.ok, false);
    assert.match(bad.json.result.error, /类型/);

    // 旧版本/公司专属的类型名也要能原样保留，不再按白名单丢弃。
    await M.ok({ action: 'ticket_update', id: noted2.id, type: '售后' });
    const after = await M.get('hours', { month: '2026-10' });
    assert.equal(after.view.tickets.find((item) => item.title === '修改发送接口变量空字符串校验').type, '售后');
  });

  await checkAsync('本月工单一览：按日期排序，带项目名与完成度', async () => {
    const view = await M.get('hours', { month: '2026-10' });
    const tickets = view.view.tickets;
    assert.equal(tickets.length, 3);
    assert.deepEqual(tickets.map((item) => item.date), ['2026-10-09', '2026-10-14', '2026-10-16']);
    assert.equal(tickets[0].projectName, '示例政务客户二期');
    assert.equal(tickets[0].hours, null);
    assert.equal(tickets[2].note, '不改');
    assert.equal(view.view.ticketHours, 18);
    assert.equal(view.view.loggedHours, 18, '工单小时必须就是已录工时');
  });

  const onlyHours = await M.ok({ action: 'ticket_update', id: withHours.data.id, hours: 10 });
  check('只改小时数时，提示语只报「工时」', () => {
    assert.equal(onlyHours.message, '已更新工单「排障 #10002联通」：工时');
  });
  await checkAsync('改工单小时数：工时台账跟着变，不会叠加成两条', async () => {
    const state = M.readState();
    const day = state.days['2026-10-14'];
    assert.equal(day.entries.length, 1, `应当只有一条条目，实际 ${day.entries.length}`);
    assert.equal(day.entries[0].hours, 10);
    const view = await M.get('hours', { month: '2026-10' });
    assert.equal(view.view.loggedHours, 11); // 10 + 1
    assert.equal(view.view.ticketHours, 11);
  });

  await M.ok({ action: 'ticket_update', id: withHours.data.id, date: '2026-10-15', project: '示例政务客户二期' });
  await checkAsync('改日期 / 改项目：条目跟着迁移，旧日期不留残影', async () => {
    const state = M.readState();
    assert.equal(state.days['2026-10-14'], undefined, '旧日期的记录应当被收掉');
    assert.equal(state.days['2026-10-15'].entries[0].hours, 10);
    assert.equal(state.days['2026-10-15'].entries[0].projectId, state.tickets.find((t) => t.id === withHours.data.id).projectId);
    const view = await M.get('hours', { month: '2026-10' });
    assert.equal(view.view.loggedHours, 11, '总数不该变');
  });

  await M.ok({ action: 'ticket_update', id: withHours.data.id, hours: null });
  check('把工单改成「无工时」，对应条目要收回', () => {
    const state = M.readState();
    assert.equal(state.days['2026-10-15'], undefined);
  });

  await M.ok({ action: 'ticket_remove', id: noted.data.id });
  await checkAsync('删工单：连同它带的小时一起消失', async () => {
    const state = M.readState();
    assert.equal(state.tickets.length, 2);
    assert.equal(state.days['2026-10-16'], undefined);
    const view = await M.get('hours', { month: '2026-10' });
    assert.equal(view.view.loggedHours, 0);
    assert.equal(view.view.ticketHours, 0);
  });

  await checkAsync('工单标题必填、工时越界要拒绝', async () => {
    const a = await M.post({ action: 'ticket_add', title: '   ' });
    assert.equal(a.json.result.ok, false);
    assert.match(a.json.result.error, /标题/);
    const tooBig = await M.post({ action: 'ticket_add', title: '超时', hours: 301 });
    assert.equal(tooBig.json.result.ok, false);
    assert.match(tooBig.json.result.error, /0~300/);
    // 300 本身要能存进去（一张「工时派发」单可能一次挂整个项目的额度）
    const big = await M.ok({ action: 'ticket_add', title: '批量派发', hours: 300, date: '2026-10-20' });
    assert.equal(big.data.ticket.hours, 300);
    const shown = (await M.get('hours', { month: '2026-10' })).view.tickets.find((item) => item.title === '批量派发');
    assert.equal(shown.hours, 300, '台账里的条目也要能到 300');
  });
}

/* ------------------------------------------------------------------ *
 * 16b. 历史完成
 * ------------------------------------------------------------------ */

const P = await harness('history');

group('16b. 今日页的「历史完成」');
{
  await P.ok({ action: 'todo_create', title: '上周做完的事', plannedDate: '2026-10-13' });
  await P.ok({ action: 'todo_complete', task: '上周做完的事', date: '2026-10-13' });
  await P.ok({ action: 'todo_create', title: '更早做完的事', plannedDate: '2026-10-01' });
  await P.ok({ action: 'todo_complete', task: '更早做完的事', date: '2026-10-01' });
  await P.ok({ action: 'todo_create', title: '本周做完的事', plannedDate: '2026-10-21' });
  await P.ok({ action: 'todo_complete', task: '本周做完的事', date: '2026-10-21' });

  const view = (await P.get('today', { date: '2026-10-23' })).view;

  check('本周之前的完成进 historyDone，本周的不进', () => {
    assert.equal(view.week.from, '2026-10-19');
    const titles = view.historyDone.map((item) => item.title);
    assert.deepEqual(titles, ['上周做完的事', '更早做完的事'], `实际：${JSON.stringify(titles)}`);
    assert.ok(!titles.includes('本周做完的事'), '本周完成的应当留在 weekDone');
    assert.deepEqual(view.weekDone.map((item) => item.title), ['本周做完的事']);
  });

  check('historyTotal 是真实总数，historyDone 按完成日倒序', () => {
    assert.equal(view.historyTotal, 2);
    assert.equal(view.stats.historyDoneCount, 2);
    assert.equal(view.historyDone[0].completedDate, '2026-10-13');
    assert.equal(view.historyDone[1].completedDate, '2026-10-01');
  });

  await checkAsync('撤销之后就从历史完成里消失', async () => {
    await P.ok({ action: 'todo_undo', task: '更早做完的事' });
    const after = (await P.get('today', { date: '2026-10-23' })).view;
    assert.equal(after.historyTotal, 1);
    assert.deepEqual(after.historyDone.map((item) => item.title), ['上周做完的事']);
  });

  await checkAsync('历史完成不会把放弃的算进去', async () => {
    await P.ok({ action: 'todo_create', title: '放弃掉的事', plannedDate: '2026-10-02' });
    await P.ok({ action: 'todo_drop', task: '放弃掉的事', reason: '不做' });
    const after = (await P.get('today', { date: '2026-10-23' })).view;
    assert.ok(!after.historyDone.some((item) => item.title === '放弃掉的事'), '放弃的不该进历史完成');
  });
}

/* ------------------------------------------------------------------ *
 * 17. 项目可修改
 * ------------------------------------------------------------------ */

const N = await harness('project-edit');

group('17. 项目建好之后可以改');
{
  const created = await N.ok({ action: 'project_create', name: '订单中台', code: 'OMS', emoji: '📦', owner: '我' });

  const renamed = await N.ok({ action: 'project_update', id: created.data.id, name: '订单中台（二期）' });
  check('只改名字时，提示语只报「名称」', () => {
    assert.equal(renamed.message, '已更新项目「订单中台（二期）」：名称');
    assert.equal(N.readState().projects[0].name, '订单中台（二期）');
  });

  const unchanged = await N.ok({
    action: 'project_update',
    id: created.data.id,
    name: '订单中台（二期）',
    code: 'OMS',
    emoji: '📦',
    owner: '我',
  });
  check('原样提交时明确说「没有任何改动」', () => {
    assert.match(unchanged.message, /没有任何改动/);
  });

  const detailed = await N.ok({
    action: 'project_update',
    id: created.data.id,
    code: 'OMS2',
    owner: '张三',
    description: '订单导出与对账',
    startedAt: '2026-10-01',
  });
  check('代号 / 负责人 / 说明 / 启动日都能改', () => {
    assert.match(detailed.message, /代号/);
    assert.match(detailed.message, /负责人/);
    assert.match(detailed.message, /说明/);
    assert.match(detailed.message, /启动日/);
    assert.ok(!/名称/.test(detailed.message), '没改名字就不该报名称');
    const project = N.readState().projects[0];
    assert.equal(project.code, 'OMS2');
    assert.equal(project.owner, '张三');
    assert.equal(project.description, '订单导出与对账');
    assert.equal(project.startedAt, '2026-10-01');
  });

  await checkAsync('改名不影响挂在这个项目下的待办和工单', async () => {
    await N.ok({ action: 'todo_create', title: '导出接口', project: '订单中台（二期）', plannedDate: '2026-10-12' });
    await N.ok({ action: 'ticket_add', title: '联调', project: '订单中台（二期）', date: '2026-10-12', hours: 7.5 });
    await N.ok({ action: 'project_update', id: created.data.id, name: 'OMS 项目' });
    const state = N.readState();
    assert.equal(state.todos[0].projectId, created.data.id, '待办还是挂在这个项目上');
    assert.equal(state.tickets[0].projectId, created.data.id, '工单也还在');
    const view = await N.get('projects');
    assert.equal(view.view[0].name, 'OMS 项目');
    assert.equal(view.view[0].totalCount, 1);
  });

  await checkAsync('项目「投入工时」跟着工单走，而不是永远 0h', async () => {
    const before = await N.get('projects');
    const target = before.view.find((item) => item.name === 'OMS 项目');
    assert.ok(target, '找不到 OMS 项目');
    const base = target.hours;

    await N.ok({ action: 'ticket_add', title: '联调', project: 'OMS 项目', date: '2026-10-20', hours: 7.5 });
    await N.ok({ action: 'ticket_add', title: '写文档', project: 'OMS 项目', date: '2026-10-22', hours: 3 });
    const grown = (await N.get('projects')).view.find((item) => item.name === 'OMS 项目');
    assert.equal(grown.hours, base + 10.5, `投入工时应增加 10.5h，实际 ${grown.hours}`);
    assert.equal(grown.lastActivity, '2026-10-22', '最近活动应当跟着工单日期走');

    const month = await N.get('hours', { month: '2026-10' });
    const ticket = month.view.tickets.find((item) => item.title === '联调');
    await N.ok({ action: 'ticket_update', id: ticket.id, hours: 2 });
    const shrunk = (await N.get('projects')).view.find((item) => item.name === 'OMS 项目');
    // 原来是 7.5 + 3，把 7.5 改成 2 之后是 2 + 3
    assert.equal(shrunk.hours, base + 5, `改小时数后应当是 ${base + 5}h，实际 ${shrunk.hours}`);
  });

  await checkAsync('别的项目的工单不会算进来', async () => {
    await N.ok({ action: 'project_create', name: '另一个项目' });
    await N.ok({ action: 'ticket_add', title: '别人的活', project: '另一个项目', date: '2026-10-21', hours: 4 });
    const view = (await N.get('projects')).view;
    const other = view.find((item) => item.name === '另一个项目');
    const mine = view.find((item) => item.name === 'OMS 项目');
    assert.equal(other.hours, 4, '新项目只该有它自己的 4h');
    assert.ok(mine.hours > other.hours, '两个项目的工时应各自独立');
  });

  await checkAsync('状态可以来回切，归档会记时间戳', async () => {
    await N.ok({ action: 'project_update', id: created.data.id, status: 'archived' });
    let project = N.readState().projects[0];
    assert.equal(project.status, 'archived');
    assert.ok(project.archivedAt, '归档应当记时间');
    await N.ok({ action: 'project_update', id: created.data.id, status: 'active' });
    project = N.readState().projects[0];
    assert.equal(project.status, 'active');
    assert.equal(project.archivedAt, null);
  });
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log(`\n${'─'.repeat(64)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言`);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const item of failures) {
    console.log(`\n  ✗ ${item.label}\n${item.error.stack}`);
  }
}
rmSync(ROOT, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
