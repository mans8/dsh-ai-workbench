/**
 * AI 工作台账 — Client 半体渲染测试。
 *
 * 思路：用一个 ~120 行的 mini-React 垫片真正执行 client.js 里的组件树
 * （createElement / useState / useEffect 都实现），配上从**真实 Host** 抓下来的
 * 视图 JSON，把四个分页各渲染一遍。
 *
 * 这样能在不装 DSH、不开浏览器的情况下抓到绝大多数 UI 运行时错误：
 * 读空值、调用不存在的字段、组件签名不匹配、hook 顺序问题等等。
 *
 * 运行：node test/client.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_DIR = join(HERE, '..');
const ROOT = mkdtempSync(join(tmpdir(), 'aiwb-client-'));

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error('这个用例是 async 的，必须用 await checkAsync(...) 包起来，否则断言不会被执行');
    }
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label}\n      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

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

/** 从渲染树里取出样式表文本（style 子节点或 dangerouslySetInnerHTML 两种写法都认）。 */
function cssOf(tree) {
  return (function find(node) {
    if (!node) return null;
    if (node.type === 'style') {
      const inner = node.props && node.props.dangerouslySetInnerHTML;
      if (inner && typeof inner.__html === 'string') return inner.__html;
      return (node.children || []).map((c) => c.text || '').join('');
    }
    for (const child of node.children || []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  })(tree) || '';
}

function group(title) {
  console.log(`\n${title}`);
}

/* ================================================================== *
 * 1. mini-React：够用的 createElement / useState / useEffect
 * ================================================================== */

function createMiniReact() {
  const instances = new Map();
  const overrides = {};
  const pendingEffects = [];
  let currentPath = '';
  let currentName = '';
  let hookIndex = 0;

  const isFn = (value) => typeof value === 'function';
  const isHost = (value) => typeof value === 'string';

  function createElement(type, props, ...children) {
    const flat = [];
    const push = (child) => {
      if (Array.isArray(child)) child.forEach(push);
      else if (child === null || child === undefined || typeof child === 'boolean') return;
      else flat.push(child);
    };
    children.forEach(push);
    // 与 React 一致：没有传可变子元素时，保留 props.children（显式 children 属性）。
    const next = { ...(props || {}) };
    if (flat.length === 1) next.children = flat[0];
    else if (flat.length > 1) next.children = flat;
    return { __el: true, type, props: next };
  }

  function instanceOf(path) {
    if (!instances.has(path)) instances.set(path, { hooks: [], deps: {}, renders: 0 });
    return instances.get(path);
  }

  function useState(initial) {
    const inst = instanceOf(currentPath);
    const index = hookIndex++;
    if (!(index in inst.hooks)) {
      const preset = overrides[currentName];
      inst.hooks[index] = preset && index in preset
        ? preset[index]
        : isFn(initial)
          ? initial()
          : initial;
    }
    const setter = (next) => {
      inst.hooks[index] = isFn(next) ? next(inst.hooks[index]) : next;
    };
    return [inst.hooks[index], setter];
  }

  function useEffect(fn, deps) {
    const inst = instanceOf(currentPath);
    const index = hookIndex++;
    const key = `e${index}`;
    const prev = inst.deps[key];
    const changed = !prev || !deps || prev.length !== deps.length || deps.some((dep, i) => dep !== prev[i]);
    if (changed) {
      inst.deps[key] = deps ? deps.slice() : null;
      pendingEffects.push(fn);
    }
  }

  /** 深度优先渲染，返回一棵 {type, props, children, text} 的简化树。 */
  function renderNode(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node), children: [] };
    if (Array.isArray(node)) {
      return { type: '#frag', children: node.map((child, i) => renderNode(child, `${path}.${i}`)).filter(Boolean) };
    }
    if (!node.__el) return null;

    const { type, props } = node;
    if (isFn(type)) {
      const savePath = currentPath;
      const saveName = currentName;
      const saveIndex = hookIndex;
      currentPath = path;
      currentName = type.name || 'anonymous';
      hookIndex = 0;
      instanceOf(path).renders += 1;
      let output;
      try {
        output = type(props);
      } finally {
        currentPath = savePath;
        currentName = saveName;
        hookIndex = saveIndex;
      }
      return renderNode(output, `${path}~`);
    }

    if (isHost(type)) {
      const kids = props.children;
      const list = Array.isArray(kids) ? kids : kids === undefined || kids === null ? [] : [kids];
      return {
        type,
        props,
        children: list.map((child, i) => renderNode(child, `${path}/${i}`)).filter(Boolean),
      };
    }
    return null;
  }

  return {
    createElement,
    useState,
    useEffect,
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    Fragment: '#fragment',
    /**
     * 预设某个组件第 N 个 useState 的初值（按 hook 下标索引，测试切分页 / 打开弹层用）。
     * 注意 WorkPage 的前两个 hook 被 useSnapshot 占用，所以 tab 是下标 2。
     */
    presets(map) {
      // 每次预设都当作一次全新的挂载：清掉 hook 状态，否则第二次渲染时
      // 已存在的 useState 初值会盖过预设（同一路径的实例会被复用）。
      instances.clear();
      for (const key of Object.keys(overrides)) delete overrides[key];
      Object.assign(overrides, map);
    },
    /** 渲染入口，返回简化树。 */
    render(element) {
      pendingEffects.length = 0;
      const tree = renderNode(element, 'root');
      const effectErrors = [];
      for (const fn of pendingEffects.splice(0)) {
        try {
          fn();
        } catch (error) {
          effectErrors.push(error);
        }
      }
      return { tree, effectErrors };
    },
    instanceCount: () => instances.size,
  };
}

/** 把简化树里的文字收集出来，供断言使用。 */
function textOf(node) {
  if (!node) return '';
  if (node.type === '#text') return node.text;
  return (node.children || []).map(textOf).join(' ');
}

/**
 * 收集树里所有 <button> 的可见文案。
 *
 * 这条断言来自一个真实事故：批量把「直接调用组件」改成 h(组件, ...) 时，
 * 换行写法的调用（`Btn(` 后面换行再给 props）被漏掉了，于是那些按钮虽然渲染出来了，
 * 但第二个参数（文案）被当成多余实参丢弃 —— 界面上只剩一个个空的小绿块。
 * 所以：**任何 button 都不许没有文案**。
 */
function collectButtons(node, out = []) {
  if (!node) return out;
  if (node.type === 'button') {
    // 图标按钮没有文字，但会有 aria-label —— 有可访问名字就不算空按钮
    const text = textOf(node).replace(/\s+/g, ' ').trim();
    const label = String(node.props?.['aria-label'] ?? node.props?.title ?? '').trim();
    out.push(text || label);
  }
  for (const child of node.children || []) collectButtons(child, out);
  return out;
}

/** 在渲染树里找第一个满足条件的节点。 */
function findNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const hit = findNode(child, predicate);
    if (hit) return hit;
  }
  return null;
}

/** 统计某个子树里满足条件的节点数。 */
function countIn(node, predicate) {
  if (!node) return 0;
  let n = predicate(node) ? 1 : 0;
  for (const child of node.children || []) n += countIn(child, predicate);
  return n;
}

/** 统计渲染出的元素数量（粗略的复杂度指标）。 */
function sizeOf(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((sum, child) => sum + sizeOf(child), 0);
}

/* ================================================================== *
 * 2. 从真实 Host 抓视图数据
 * ================================================================== */

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

function makeReq(method, url, body) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
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

/** 起一个真实的 Host 实例并返回 { get, post }。 */
async function bootHost(label, startClock = '2026-10-12') {
  let clock = startClock;
  process.env.AI_WORKBENCH_STATE_FILE = join(ROOT, label, 'state.json');
  process.env.DSH_HOME = join(ROOT, label);
  const routes = new Map();
  const tools = new Map();
  const ctx = {
    effect: (fn) => fn(),
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => {};
      },
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => {};
      },
    },
  };
  const mod = await import(`${join(PLUGIN_DIR, 'index.js')}?v=${encodeURIComponent(label)}`);
  mod.apply(ctx, {});
  const route = routes.get('/ai-workbench/api');

  async function call(method, url, body) {
    const res = makeRes();
    await route.handler(makeReq(method, url, body), res);
    return JSON.parse(res.body);
  }

  return {
    setClock: (value) => {
      clock = value;
    },
    get: (view, params = {}) => call('GET', `/ai-workbench/api?${new URLSearchParams({ view, today: clock, ...params })}`),
    post: (body) => call('POST', '/ai-workbench/api', { today: clock, ...body }),
  };
}

/** 造一份有代表性的工作台账，然后把各视图抓下来。 */
async function collectViews() {
  // 先在 2026-10-09 建账，再拨到 10-12 —— 这样逾期、今日待办都是真实算出来的。
  const host = await bootHost('client-fixture', '2026-10-09');
  const order = (await host.post({ action: 'project_create', name: '订单中台', code: 'OMS', emoji: '📦', owner: '我' })).result.data.id;
  const recon = (await host.post({ action: 'project_create', name: '对账系统', code: 'REC', emoji: '🧾' })).result.data.id;

  await host.post({ action: 'todo_create', title: '订单导出接口重构', project: '订单中台', priority: 'P1', tags: ['重构'] });
  await host.post({ action: 'todo_create', title: '支付回调幂等性改造', project: '订单中台', priority: 'P0' });
  await host.post({ action: 'todo_create', title: '对账系统灰度方案设计', project: '对账系统', dueDate: '2026-10-09' });
  await host.post({ action: 'todo_create', title: '整理接口文档', progress: 40 });
  await host.post({ action: 'todo_create', title: '背单词' });
  await host.post({ action: 'todo_create', title: '与产品对齐导出字段' });

  await host.post({ action: 'todo_complete', task: '订单导出接口重构', date: '2026-10-05', note: 'QPS 从 120 提到 900' });
  await host.post({ action: 'todo_complete', task: '支付回调幂等性改造', date: '2026-10-06' });
  await host.post({ action: 'log_note', title: '梳理导出字段口径', date: '2026-10-07', project: '订单中台' });
  // 今天完成一件 —— 「本周完成」需要本周内的记录
  await host.post({ action: 'todo_complete', task: '与产品对齐导出字段', date: '2026-10-12' });

  // ── 拨到今天 ──
  host.setClock('2026-10-12');

  await host.post({ action: 'todo_create', title: '每日站会', repeat: { freq: 'workdays' }, priority: 'P2' });
  await host.post({ action: 'todo_create', title: '周一复盘', repeat: { freq: 'weekly', weekdays: [1] } });

  // 手工把 10-14 标成放假日，让设置弹层里能看到这条覆盖
  await host.post({ action: 'holiday_override_set', date: '2026-10-14', kind: 'holiday' });

  await host.post({ action: 'report_create', type: 'weekly', date: '2026-10-09' });
  const monthly = await host.post({ action: 'report_create', type: 'monthly', date: '2026-10-05' });
  await host.post({ action: 'report_create', type: 'project', project: '订单中台', date: '2026-10-05' });
  await host.post({ action: 'report_archive', id: monthly.result.data.id });

  const views = {};
  for (const [key, view, params] of [
    ['bootstrap', 'bootstrap', {}],
    ['today', 'today', {}],
    ['board', 'board', {}],
    ['todos', 'todos', { status: 'all' }],
    ['projects', 'projects', {}],
    ['stats', 'stats', { dim: 'month', from: '2026-01-01', to: '2026-12-31' }],
    ['statsYear', 'stats', { dim: 'year', from: '2026-01-01', to: '2026-12-31', heatmap: '1' }],
    ['statsDay', 'stats', { dim: 'day', from: '2026-10-01', to: '2026-10-12' }],
    ['reports', 'reports', { status: 'all' }],
  ]) {
    views[key] = (await host.get(view, params)).view;
  }
  views.report = (await host.get('report', { id: views.reports.reports[0].id })).view;
  views.orderId = order;
  views.reconId = recon;
  return views;
}

/* ================================================================== *
 * 3. 装载 client.js 并渲染
 * ================================================================== */

/* ================================================================== *
 * 4. 主流程
 * ================================================================== */

console.log('AI 工作台账 · Client 半体渲染测试');

const views = await collectViews();

// 载入 client.js（它是同步的 window.__ModuleLoader__.load 调用）
let captured = null;
const slots = { panel: null, main: null };

globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      captured = def;
    },
  },
  localStorage: { getItem: () => null, setItem: () => {} },
};
globalThis.document = {
  createElement: () => ({ click: () => {}, style: {} }),
  body: { appendChild: () => {}, removeChild: () => {} },
};
globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) });
globalThis.Blob = class Blob {};
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.URL.revokeObjectURL = () => {};
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

await import(join(PLUGIN_DIR, 'client.js'));

group('1. 插件装载');
check('client.js 通过 __ModuleLoader__ 注册了 factory', () => {
  assert.ok(captured, '没有捕获到 load()');
  assert.equal(captured.id, 'dsh-ai-workbench');
  assert.equal(typeof captured.factory, 'function');
});

const react = createMiniReact();
const plugin = captured.factory((name) => {
  if (name === 'react') return react;
  throw new Error(`意外的模块请求：${name}`);
});

check('factory 返回 slots 注入的插件对象', () => {
  assert.deepEqual(plugin.inject, ['slots']);
  assert.equal(typeof plugin.apply, 'function');
});

const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (_name, fn) => fn(),
    register: (config, component) => {
      if (config.name === 'sidebar.panellist') slots.panel = { config, component };
      if (config.name === 'main') {
        slots.main = { config, component };
        // 把真实 store 的 api 接出来，用来测「请求带的 today 是不是当天」
        if (typeof config.inject === 'function') slots.api = config.inject().api;
      }
      return () => {};
    },
  },
};
plugin.apply(ctx);

check('注册了 sidebar.panellist 与 main 两个槽位', () => {
  assert.ok(slots.panel, '缺少 sidebar.panellist');
  assert.ok(slots.main, '缺少 main');
  assert.equal(slots.panel.config.id, 'ai-workbench');
  assert.equal(slots.panel.config.order, 30);
  assert.equal(slots.main.config.key, 'ai-workbench');
});

check('侧栏图标可以独立渲染', () => {
  const { tree } = react.render(react.createElement(slots.panel.component, { active: true }));
  assert.equal(tree.type, 'svg');
  assert.ok(sizeOf(tree) >= 4);
});

/**
 * 这一组是「白屏回归」。
 *
 * 之前的教训：测试里的假 api 是照着我「以为面板需要什么」手写的，
 * 而插件真正暴露给面板的 api 少了 getSnapshot / subscribe，
 * 结果真机上一打开就是空白，测试却全绿。
 *
 * 所以这里改用 `main` 槽位 config.inject() 拿到的**真 api** 来断言契约与首屏渲染。
 */
group('1b. 面板与插件之间的 api 契约（白屏回归）');
{
  const realApi = slots.main.config.inject().api;

  check('api 暴露了面板用到的每一个方法', () => {
    assert.ok(realApi, 'main 槽位的 inject() 没有给出 api');
    for (const name of ['getSnapshot', 'subscribe', 'open', 'reload', 'send', 'refreshBoot', 'flash']) {
      assert.equal(typeof realApi[name], 'function', `api.${name} 不是函数（面板会直接崩）`);
    }
  });

  check('api.getSnapshot() 返回面板依赖的字段', () => {
    const snap = realApi.getSnapshot();
    assert.equal(typeof snap, 'object');
    for (const key of ['ready', 'loading', 'error', 'busy', 'flash', 'boot', 'viewName', 'viewParams', 'view', 'today']) {
      assert.ok(key in snap, `快照缺少字段 ${key}`);
    }
    assert.match(snap.today, /^\d{4}-\d{2}-\d{2}$/);
  });

  check('api.subscribe() 返回可用的退订函数', () => {
    let called = 0;
    const off = realApi.subscribe(() => {
      called += 1;
    });
    assert.equal(typeof off, 'function');
    off();
    assert.equal(called, 0);
  });

  check('用真 api 渲染 WorkPage 首屏不会崩（真机白屏就是这个原因）', () => {
    react.presets({});
    const { tree, effectErrors } = react.render(react.createElement(slots.main.component, { api: realApi }));
    assert.equal(effectErrors.length, 0, effectErrors.map((e) => e.message).join('; '));
    assert.ok(sizeOf(tree) > 20, `首屏只渲染了 ${sizeOf(tree)} 个节点`);
    assert.ok(textOf(tree).includes('AI 工作台账'));
  });

  check('api 契约没有被分页组件私自扩展（面板只应依赖上面这些）', () => {
    const extra = Object.keys(realApi).filter(
      (key) => !['getSnapshot', 'subscribe', 'open', 'reload', 'send', 'refreshBoot', 'flash'].includes(key),
    );
    assert.deepEqual(extra, [], `api 上出现了未在契约里的字段：${extra.join(', ')}`);
  });
}

/* ------------------------------------------------------------------ *
 * 各分页渲染
 * ------------------------------------------------------------------ */

/** 造一个假的 api（不真的发请求，只记录调用）。 */
function fakeApi(viewName, view) {
  const calls = [];
  return {
    calls,
    getSnapshot: () => ({
      ready: true,
      loading: false,
      error: null,
      busy: null,
      flash: null,
      boot: views.bootstrap,
      viewName,
      viewParams: {},
      view,
      today: '2026-10-12',
    }),
    subscribe: () => () => {},
    open: (name, params) => {
      calls.push(['open', name, params]);
      return Promise.resolve();
    },
    reload: () => {
      calls.push(['reload']);
      return Promise.resolve();
    },
    send: (action, payload, options) => {
      calls.push(['send', action, payload, options]);
      return Promise.resolve({ ok: true, data: { id: 'x' } });
    },
    refreshBoot: () => {
      calls.push(['refreshBoot']);
      return Promise.resolve();
    },
    flash: (kind, text) => calls.push(['flash', kind, text]),
  };
}

/** 渲染一个分页（通过预设 WorkPage 的第 0 个 useState = tab）。 */
function renderPage(tab, extraPresets = {}, viewOverride) {
  const viewMap = {
    today: views.today,
    board: views.board,
    projects: views.projects,
    reports: views.reports,
    stats: views.stats,
  };
  const api = fakeApi(tab, viewOverride ?? viewMap[tab]);
  // WorkPage 的 hook 顺序：0=snapshot(useSnapshot)、1=subscribe effect、2=tab、3=settingsOpen、4=skin
  react.presets({ WorkPage: { 2: tab }, ...extraPresets });
  const { tree, effectErrors } = react.render(react.createElement(slots.main.component, { api }));
  return { tree, text: textOf(tree), api, effectErrors };
}

group('2. 五个分页都能无异常渲染');
{
  const expectations = {
    today: ['AI 工作台账', '今日待办', '整理接口文档', '每日站会', '新增', '本周完成', '完成'],
    board: ['看板', '重要且紧急', '立即做', '排期做', '委派或批量处理', '删除或归档', '仅个人'],
    projects: ['订单中台', '对账系统', '新增项目', '完成'],
    reports: ['生成简报', '周报', '简报库', '已归档'],
    stats: ['汇总', '完成率', '完成数分布'],
  };

  for (const [tab, needles] of Object.entries(expectations)) {
    check(`「${tab}」分页渲染成功且包含关键内容`, () => {
      const { tree, text, effectErrors } = renderPage(tab);
      assert.equal(effectErrors.length, 0, `渲染副作用抛错：${effectErrors.map((e) => e.message).join('; ')}`);
      assert.ok(sizeOf(tree) > 40, `渲染树太小（${sizeOf(tree)} 个节点）`);
      for (const needle of needles) {
        assert.ok(text.includes(needle), `输出里缺少「${needle}」`);
      }
    });
  }
}

group('2b. 数据仓库：请求必须带当天日期');
{
  check('真实 store 暴露出来了', () => {
    assert.ok(slots.api, '没能从 main 的 inject 里拿到 api');
    assert.equal(typeof slots.api.open, 'function');
    assert.ok(slots.api.getSnapshot().today, '快照里应当有 today');
  });

  await checkAsync('机器日期变了之后，open 必须按「今天」发请求，而不是仓库里缓存的旧日期', async () => {
    const api = slots.api;
    const stale = api.getSnapshot().today;
    const urls = [];
    const realFetch = globalThis.fetch;
    const RealDate = globalThis.Date;
    try {
      globalThis.fetch = (url) => {
        urls.push(String(url));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, view: { date: '2026-12-01' }, rollover: null }),
        });
      };
      // 把「机器时钟」拨到一个月后
      globalThis.Date = class extends RealDate {
        constructor(...args) {
          const fake = new RealDate('2026-12-01T09:00:00+08:00');
          if (args.length === 0) super(fake.getTime());
          else super(...args);
        }
      };
      await api.open('today');
    } finally {
      globalThis.Date = RealDate;
      globalThis.fetch = realFetch;
    }
    assert.equal(urls.length, 1, `应当只发一次请求，实际 ${urls.length} 次`);
    assert.notEqual(stale, '2026-12-01', '前置条件：仓库里缓存的应当是旧日期');
    assert.match(urls[0], /today=2026-12-01/, `请求应当带今天的日期，实际：${urls[0]}`);
  });
}

group('2c. 数据仓库：乱序响应不能覆盖新数据');
{
  /** 装一个可控的 fetch：按给的 payload 顺序 resolve。 */
  function stubFetch(payloads) {
    const pending = payloads.slice();
    const urls = [];
    globalThis.fetch = (url) => {
      urls.push(String(url));
      const next = pending.shift();
      return new Promise((resolve) => {
        // 用 setTimeout(0) 让两个请求真的并发
        setTimeout(() => resolve({ ok: true, status: 200, json: () => Promise.resolve(next) }), 0);
      });
    };
    return urls;
  }

  await checkAsync('先发的慢响应回来时，不能把后发的快响应盖掉', async () => {
    const api = slots.api;
    const realFetch = globalThis.fetch;
    try {
      // 第一个请求的响应故意晚到（用一个很长的 value 表示“旧数据”）
      globalThis.fetch = ((seq) => (url) => {
        seq.push(String(url));
        const isFirst = seq.length === 1;
        return new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, view: { date: isFirst ? '旧的' : '新的' }, rollover: null }) }),
            isFirst ? 40 : 5,
          ),
        );
      })([]);

      const slow = api.open('today');
      const fast = api.open('projects');
      await Promise.all([slow, fast]);
    } finally {
      globalThis.fetch = realFetch;
    }
    const snap = api.getSnapshot();
    assert.equal(snap.viewName, 'projects', '先发慢回的那次不该改写 viewName');
    assert.equal(snap.view.date, '新的', `慢响应把新数据盖掉了：${JSON.stringify(snap.view)}`);
  });

  await checkAsync('send 的响应也不能覆盖期间切换过的分页', async () => {
    const api = slots.api;
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = ((seq) => (url, options) => {
        seq.push(String(url || 'POST'));
        const isPost = String(options?.method || '').toUpperCase() === 'POST';
        return new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, view: { date: isPost ? '写操作返回的' : '分页自己的' }, result: { ok: true } }) }),
            isPost ? 40 : 5,
          ),
        );
      })([]);

      const writing = api.send('todo_complete', { id: 'x' });
      const opening = api.open('projects');
      await Promise.all([writing, opening]);
    } finally {
      globalThis.fetch = realFetch;
    }
    const snap = api.getSnapshot();
    assert.equal(snap.view.date, '分页自己的', `写操作的慢响应盖掉了分页数据：${JSON.stringify(snap.view)}`);
  });
}

group('3. 真实数据是否正确落到界面上');
{
  check('今日页显示逾期提示', () => {
    const { text } = renderPage('today');
    assert.ok(text.includes('逾期'), '缺少逾期提示');
    assert.ok(!text.includes('积压'), '积压概念已经下线');
  });

  check('报表页列出三份报表并标注状态', () => {
    const { text } = renderPage('reports');
    assert.ok(text.includes('W41'), `缺少周报标题：${JSON.stringify(text.slice(0, 300))}`);
    assert.ok(text.includes('已归档'), '缺少已归档状态');
    assert.ok(text.includes('草稿'), '缺少草稿状态');
  });

  check('统计页给出汇总指标，且不再有任何工时指标', () => {
    const { tree, text } = renderPage('stats');
    assert.ok(/完成率/.test(text));
    assert.ok(/项/.test(text));
    for (const gone of ['投入工时', '必须工时', '工时达成率', '按项目分布', '工时']) {
      assert.ok(!text.includes(gone), `统计页不该再出现「${gone}」`);
    }
    // 完成数分布的 tooltip 说的是完成数 / 计划 / 完成率，不再带工时
    const tips = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === 'div' && node.props?.className === 'aw-trend-col') tips.push(String(node.props.title || ''));
      for (const child of node.children || []) walk(child);
    })(tree);
    assert.ok(tips.length > 0, '没有完成数分布的柱子');
    assert.ok(tips.every((tip) => tip.includes('完成率') && !tip.includes('工时')), `tooltip 不该含工时：${JSON.stringify(tips)}`);
  });

  check('统计页切到按年时渲染热力图', () => {
    const { text, effectErrors } = renderPage('stats', { StatsTab: { 0: 'year' } }, views.statsYear);
    assert.equal(effectErrors.length, 0, effectErrors.map((e) => e.message).join('; '));
    assert.ok(text.includes('热力图'), '缺少热力图');
  });

  check('项目页显示项目进度，不再有「投入 Xh」chip', () => {
    const { text } = renderPage('projects');
    assert.ok(text.includes('OMS'), '缺少项目代号');
    assert.ok(text.includes('完成'), '缺少完成进度');
    assert.ok(!text.includes('投入'), '项目卡片不该再有「投入 Xh」chip');
  });
}

group('3f. 统计页默认落在「本月」');
{
  check('首次进入统计页只发一次请求，且区间是本月', () => {
    const api = fakeApi('stats', views.stats);
    react.presets({ WorkPage: { 2: 'stats' } });
    react.render(react.createElement(slots.main.component, { api }));

    const opens = api.calls.filter((c) => c[0] === 'open' && c[1] === 'stats');
    assert.equal(opens.length, 1, `只该发一次统计请求，实际 ${opens.length} 次：${JSON.stringify(opens)}`);
    const params = opens[0][2];
    assert.equal(params.dim, 'month');
    assert.match(params.from, /^\d{4}-\d{2}-01$/, `起点应当是月初，实际 ${params.from}`);
    assert.ok(params.from.slice(0, 7) === params.to.slice(0, 7), `起止应当同一个月：${params.from} ~ ${params.to}`);
    assert.ok(!/^\d{4}-01-01$/.test(params.from) || params.from === new Date().toISOString().slice(0, 8) + '01', '不该退回到 1 月 1 日');
  });

  check('「本月」预设高亮，「本年」不高亮', () => {
    const api = fakeApi('stats', views.stats);
    react.presets({ WorkPage: { 2: 'stats' } });
    const { tree } = react.render(react.createElement(slots.main.component, { api }));
    const toggles = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === 'button' && ['本月', '本季度', '本年', '近 30 天'].includes(textOf(node).trim())) {
        toggles.push({ label: textOf(node).trim(), className: node.props?.className || '' });
      }
      for (const child of node.children || []) walk(child);
    })(tree);
    const on = toggles.filter((t) => /is-on/.test(t.className)).map((t) => t.label);
    assert.deepEqual(on, ['本月'], `高亮的应当是「本月」，实际 ${JSON.stringify(on)}`);
  });
}

group('3g. 换肤：三套皮肤 + 记住选择');
{
  check('根节点带 data-skin，默认 dusk', () => {
    const { tree } = renderPage('today');
    const page = findNode(tree, (n) => n.type === 'div' && /aw-page/.test(n.props?.className || ''));
    assert.ok(page, '找不到 .aw-page');
    assert.equal(page.props['data-skin'], 'horizon', `默认皮肤应当是 horizon，实际 ${page.props['data-skin']}`);
  });

  check('三套皮肤都在 CSS 里声明了完整令牌', () => {
    const { tree } = renderPage('today');
    const css = cssOf(tree);
    for (const skin of ['horizon', 'lido', 'dusk', 'jade']) {
      assert.match(css, new RegExp(`\\.aw-page\\[data-skin="${skin}"\\]`), `缺少 ${skin} 皮肤`);
    }
  });

  check('设置弹层里能选外观，选中值就是当前皮肤', () => {
    const api = fakeApi('reports', views.reports);
    react.presets({ WorkPage: { 2: 'reports', 3: true } });
    const { tree } = react.render(react.createElement(slots.main.component, { api }));
    const page = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-modal is-settings');
    assert.ok(page, '设置弹层没渲染');
    const select = findNode(page, (n) => n.type === 'select' && (n.children || []).some((o) => o.type === 'option' && /暮色/.test(textOf(o))));
    assert.ok(select, '找不到「外观」下拉');
    const options = (select.children || []).map((o) => textOf(o).trim());
    assert.deepEqual(options, ['Horizon', '暖滩', '暮色', '青玉']);
    assert.equal(select.props.value, 'horizon', '默认选中 Horizon');
  });

  check('首屏把「今日待办」的数字放到最大一级', () => {
    const { tree } = renderPage('today');
    const head = findNode(tree, (n) => n.type === 'section' && n.props?.className === 'aw-dayhead');
    assert.ok(head, '首屏缺少 dayhead');
    const num = findNode(head, (n) => n.type === 'span' && n.props?.className === 'aw-dayhead-num');
    assert.ok(num, '缺少今日待办的大数字');
    assert.equal(textOf(num).trim(), String(views.today.stats.plannedCount));
    assert.ok(textOf(head).includes('今日待办'), '数字旁边要有标签');
  });
}

group('3g3. 设置弹层与分页条的紧凑度');
{
  check('设置弹层是行式布局：左名称右控件，组间大留白', () => {
    const css = cssOf(renderPage('today').tree) || '';
    for (const rule of ['.aw-modal.is-settings{', '.aw-set-group{', '.aw-set-row{', '.aw-set-label{', '.aw-set-ctl{']) {
      assert.ok(css.includes(rule), `缺少 ${rule} —— 设置弹层会失去行式布局`);
    }
    // 一行一项：两列栅格，名称在左、控件在右
    const row = (css.match(/^\.aw-set-row\{[^}]*\}/m) || [])[0];
    assert.match(row, /grid-template-columns:minmax\(0,1fr\) minmax\(220px,360px\)/, `行应当是「名称 | 控件」两列：${row}`);
    // 组间多留白、组内少留白
    const group = (css.match(/^\.aw-set-group\{[^}]*\}/m) || [])[0];
    assert.match(group, /margin-top:40px/, `组间距应当明显大于行间距：${group}`);
    assert.match(row, /padding:10px 0/, `行内边距应当更小：${row}`);
    // 弹窗自身是唯一的框：没有整页接管的隐藏规则，也不再套一层设置页卡片
    assert.ok(!/\.aw-inner\.is-settings/.test(css), '不应再有整页接管的隐藏规则');
    assert.ok(!/\.aw-settings-page\{/.test(css), '不应再套一层设置页卡片');
  });

  check('分页是左栏竖排导航，选中项有指示条', () => {
    const css = cssOf(renderPage('today').tree) || '';
    const rule = (css.match(/^\.aw-tabs\{[^}]*\}/m) || [])[0];
    assert.match(rule, /flex-direction:column/, `分页应当竖排在左栏：${rule}`);
    assert.match(css, /\.aw-tab\.is-on::after\{[^}]*background:var\(--accent\)/, '选中项应当有指示条');
    assert.match(css, /@media \(max-width:1080px\)/, '窄屏应当降级成横向分页条');
  });
}

group('3i. design.md 契约：规范写了什么，代码就得是什么');
{
  const docPath = join(PLUGIN_DIR, 'design.md');
  const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';

  check('design.md 存在，且明确自己是规范而不是日志', () => {
    assert.ok(doc.length > 2000, `design.md 太短或不存在（${doc.length} 字符）`);
    assert.match(doc, /这是规范，不是记录/, '开头要说明它的地位');
    assert.match(doc, /DESIGN-LOG\.md/, '要指向决策日志');
  });

  check('文档里写的尺度值与样式表一致', () => {
    const css = cssOf(renderPage('today').tree) || '';
    // 文档中声明的关键值必须能在 CSS 里找到原型
    const pairs = [
      ['--fs-caption:12px', '字号 caption'],
      ['--fs-body:14px', '字号 body'],
      ['--fs-head:26px', '字号 head'],
      ['--fs-display:32px', '字号 display'],
      ['--r-ctl:999px', '控件圆角'],
      ['--r-card:20px', '卡片圆角'],
      ['--r-inner:12px', '内部圆角'],
      ['--ctl-h:50px', '控件高度'],
    ];
    for (const [needle, label] of pairs) {
      assert.ok(doc.includes(needle), `design.md 没有声明 ${label}（${needle}）`);
      assert.ok(css.includes(needle), `样式表里找不到文档声明的 ${label}（${needle}）`);
    }
  });

  check('字重只有 400 / 500 / 600（文档第 5 节）', () => {
    const css = cssOf(renderPage('today').tree) || '';
    const weights = new Set((css.match(/font-weight:\d+/g) || []).map((x) => x.split(':')[1]));
    const bad = [...weights].filter((w) => !['400', '500', '600'].includes(w));
    assert.deepEqual(bad, [], `出现了文档没允许的字重：${JSON.stringify(bad)}`);
    assert.match(doc, /字重只有 400 \/ 500 \/ 600/, '文档要写清这条');
  });

  check('颜色只出现在皮肤块里（文档第 2 节）', () => {
    const css = cssOf(renderPage('today').tree) || '';
    // 去掉四个皮肤块 + 共用尺度块之后，不应再有十六进制颜色
    const stripped = css
      .replace(/\/\*[\s\S]*?\*\//g, '') // 注释（含 stamp 里记的参考色值）不算颜色声明
      .replace(/\.aw-page\[data-skin="[a-z]+"\]\{[\s\S]*?\n\}/g, '')
      .replace(/\.aw-page\{[\s\S]*?\n\}/, '');
    const hex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepEqual(hex, [], `皮肤块外面还有字面量颜色：${JSON.stringify(hex.slice(0, 5))}`);
  });

  check('horizon 的输入框描边是参考稿原值 #E0E5F2（design.md 里登记的例外）', () => {
    const css = cssOf(renderPage('today').tree) || '';
    const horizon = (css.match(/\.aw-page\[data-skin="horizon"\]\{[\s\S]*?\n\}/) || [])[0] || '';
    assert.match(horizon, /--field-line:#E0E5F2/, '描边应当与参考稿一致');
    // 这个例外成立的前提：字段必须有 label，不能只靠边框区分
    assert.match(doc, /已批准的唯一例外/, 'design.md 要写明这是例外');
    assert.match(doc, /label/, 'design.md 要写明可读性由 label 承担');
  });

  check('左栏 232px / 内容 1180px / 窄屏 1080px 断点都在', () => {
    const css = cssOf(renderPage('today').tree) || '';
    assert.match(doc, /232px/, '文档要写左栏宽度');
    assert.ok(css.includes('flex:0 0 232px'), '左栏宽度与文档不一致');
    assert.ok(css.includes('max-width:1180px'), '内容区宽度与文档不一致');
    assert.ok(css.includes('@media (max-width:1080px)'), '窄屏断点与文档不一致');
  });
}

group('3h. 报表页的兜底：缺字段也要渲染出来');
{
  check('宿主没给 counts 时，报表库照样渲染（不再整页卡在加载中）', () => {
    const broken = { ...views.reports, counts: undefined };
    const api = fakeApi('reports', broken);
    react.presets({ WorkPage: { 2: 'reports' } });
    const text = textOf(react.render(react.createElement(slots.main.component, { api })).tree);
    assert.ok(!text.includes('加载中…'), '不该卡在加载中');
    assert.ok(text.includes('简报库'), '简报库不见了');
    assert.match(text, /草稿\s*\d+/, '草稿计数应当从列表里自己数出来');
  });

}

group('3f2. 生成简报弹窗：周报日期、分类口径与维度');
{
  /** 弹窗节点（卡片上也有同名按钮，一律在弹窗内部找）。 */
  function findModal(element) {
    return findNode(
      react.render(element).tree,
      (n) => n.type === 'div' && /aw-modal/.test(String(n.props?.className || '')) && textOf(n).includes('维度'),
    );
  }

  /** 点「生成简报」按钮打开弹窗。 */
  function openGenerate() {
    const api = fakeApi('reports', views.reports);
    react.presets({ WorkPage: { 2: 'reports' } });
    const element = react.createElement(slots.main.component, { api });
    const trigger = findNode(react.render(element).tree, (n) => n.type === 'button' && textOf(n).trim() === '生成简报');
    assert.ok(trigger, '找不到「生成简报」按钮');
    trigger.props.onClick();
    const modal = findModal(element);
    assert.ok(modal, '点按钮后没有弹出生成简报弹窗');
    return { api, element, modal };
  }

  function dateInputs(node) {
    const dates = [];
    (function walk(n) {
      if (!n) return;
      if (n.type === 'input' && n.props?.type === 'date') dates.push(n);
      for (const child of n.children || []) walk(child);
    })(node);
    return dates;
  }

  function submitButton(modal) {
    return findNode(modal, (n) => n.type === 'button' && textOf(n).trim() === '生成简报');
  }

  check('默认给「本周一 ~ 本周五」两个日期框，不是单个锚点日期', () => {
    const { modal } = openGenerate();
    const dates = dateInputs(modal);
    assert.equal(dates.length, 2, `周报应当有两个日期框，实际 ${dates.length} 个`);
    const from = new Date(`${dates[0].props.value}T00:00:00`);
    const to = new Date(`${dates[1].props.value}T00:00:00`);
    assert.equal(from.getDay(), 1, `起点应当是周一，实际 ${dates[0].props.value}（周${'日一二三四五六'[from.getDay()]}）`);
    assert.equal(to.getDay(), 5, `终点应当是周五，实际 ${dates[1].props.value}（周${'日一二三四五六'[to.getDay()]}）`);
    assert.equal((to - from) / 86400000, 4, '应当是连续 5 天');
    assert.ok(findNode(modal, (n) => n.type === 'input' && n.props?.title === '周报区间起点'), '起点日期框缺少说明');
    assert.ok(findNode(modal, (n) => n.type === 'input' && n.props?.title === '周报区间终点'), '终点日期框缺少说明');
  });

  check('表单竖排：一项一行、名称在上、控件占满整行', () => {
    const { modal } = openGenerate();
    const form = findNode(
      modal,
      (n) => n.type === 'div' && String(n.props?.className || '') === 'aw-form-vertical',
    );
    assert.ok(form, '生成弹窗应当用竖排表单容器（aw-form-vertical）');
    assert.ok(!JSON.stringify(modal).includes('gridColumn'), '竖排表单里不该再有栅格列跨度');

    const fields = [];
    (function walk(n) {
      if (!n) return;
      if (n.type === 'div' && String(n.props?.className || '') === 'aw-field') {
        fields.push(n);
        return;
      }
      for (const child of n.children || []) walk(child);
    })(form);

    assert.deepEqual(
      fields.map((field) => textOf(field.children[0]).trim()),
      ['维度', '类型', '项目分类', '区间起点', '区间终点'],
      '字段应当按填写顺序从上往下排',
    );
    for (const field of fields) {
      assert.ok(field.children.length >= 2, `「${textOf(field.children[0]).trim()}」缺少输入区`);
      assert.equal(field.props.style, undefined, '字段名在上、控件全宽交给 CSS，不再逐项写行内样式');
    }
  });

  check('项目分类默认「仅工作」，三个选项齐全', () => {
    const { modal } = openGenerate();
    const select = findNode(
      modal,
      (n) =>
        n.type === 'select' &&
        (n.children || []).some((o) => o.type === 'option' && textOf(o).trim() === '仅工作'),
    );
    assert.ok(select, '找不到项目分类下拉');
    assert.equal(select.props.value, 'work', '默认应当是仅工作');
    const options = (select.children || []).map((o) => textOf(o).trim());
    assert.deepEqual(options, ['全部', '仅工作', '仅个人']);
  });

  check('改日期后生成：请求里带上 from / to 与分类口径', () => {
    const { api, element, modal } = openGenerate();
    dateInputs(modal)[0].props.onChange({ target: { value: '2026-10-01' } });

    const rerendered = findModal(element);
    submitButton(rerendered).props.onClick();

    const creates = api.calls.filter((c) => c[0] === 'send' && c[1] === 'report_create');
    assert.equal(creates.length, 1);
    assert.equal(creates[0][2].from, '2026-10-01', '应当带上自定义起点');
    assert.ok(creates[0][2].to, '应当带上终点');
    assert.equal(creates[0][2].type, 'weekly');
    assert.equal(creates[0][2].category, 'work', '默认按仅工作生成');
  });

  check('没改日期时只发 date，让宿主按默认口径算', () => {
    const { api, element, modal } = openGenerate();
    submitButton(modal).props.onClick();

    const creates = api.calls.filter((c) => c[0] === 'send' && c[1] === 'report_create');
    assert.equal(creates.length, 1);
    assert.ok(creates[0][2].date, '要带 date');
    assert.ok(!('from' in creates[0][2]) && !('to' in creates[0][2]), '没改就别传 from/to');
  });

  check('切换分类口径会带进请求', () => {
    const { api, element, modal } = openGenerate();
    const select = findNode(
      modal,
      (n) =>
        n.type === 'select' &&
        (n.children || []).some((o) => o.type === 'option' && textOf(o).trim() === '仅个人'),
    );
    select.props.onChange({ target: { value: 'personal' } });
    submitButton(findModal(element)).props.onClick();

    const creates = api.calls.filter((c) => c[0] === 'send' && c[1] === 'report_create');
    assert.equal(creates[0][2].category, 'personal');
  });

  check('切到月报时回到单个日期框', () => {
    const { element } = openGenerate();
    const typeSelect = findNode(
      findModal(element),
      (n) => n.type === 'select' && (n.children || []).some((o) => o.type === 'option' && textOf(o).includes('周报')),
    );
    typeSelect.props.onChange({ target: { value: 'monthly' } });

    const dates = dateInputs(findModal(element));
    assert.equal(dates.length, 1, '月报只要一个锚点日期');
  });

  check('项目维度下不再显示项目分类', () => {
    const { element } = openGenerate();
    findNode(findModal(element), (n) => n.type === 'button' && textOf(n).trim() === '项目维度').props.onClick();
    const modal = findModal(element);
    assert.ok(!textOf(modal).includes('项目分类'), '项目维度不该出现项目分类');
    assert.ok(textOf(modal).includes('选择项目'), '项目维度应当有项目下拉');
  });
}

group('4. 交互组件：设置弹层 / 日期编辑器 / 报表编辑器');
{
  check('保存设置只提交仍存在的字段，不带工时口径', () => {
    const api = fakeApi('reports', views.reports);
    react.presets({ WorkPage: { 2: 'reports', 3: true } });
    const element = react.createElement(slots.main.component, { api });
    const save = findNode(react.render(element).tree, (n) => n.type === 'button' && textOf(n).trim() === '保存设置');
    assert.ok(save, '找不到保存设置按钮');
    save.props.onClick();
    const updates = api.calls.filter((c) => c[0] === 'send' && c[1] === 'settings_update');
    assert.equal(updates.length, 1, `应当只发一次 settings_update：${JSON.stringify(api.calls)}`);
    assert.deepEqual(Object.keys(updates[0][2].settings).sort(), [
      'reportFiles', 'reportFooter', 'reportSignature', 'reportTemplate', 'reportTitlePrefix',
    ]);
  });

  check('设置弹层渲染成功：保留日历/报表设置，删除工时口径', () => {
    const { tree, text, effectErrors } = renderPage('reports', { WorkPage: { 2: 'reports', 3: true } });
    assert.equal(effectErrors.length, 0, effectErrors.map((e) => e.message).join('; '));
    assert.ok(text.includes('设置'), '缺少设置标题');
    for (const section of ['外观', '简报', '节假日与调休', '危险操作']) {
      assert.ok(text.includes(section), `缺少设置分组「${section}」`);
    }
    assert.ok(text.includes('内置日历'), '缺少内置日历信息');
    assert.ok(text.includes('2026-10-14'), '缺少已有的手工覆盖项');
    assert.ok(text.includes('简报标题前缀'), '缺少简报标题前缀设置项');
    const prefixInput = findNode(
      tree,
      (n) => n.type === 'input' && n.props && n.props.value === views.bootstrap.settings.reportTitlePrefix,
    );
    assert.ok(prefixInput, '简报标题前缀输入框应当回填 bootstrap 里的值');
    for (const gone of ['工时口径', '每日工时', '职级名称', '职级系数', '口径说明', '{{hours}}']) {
      assert.ok(!text.includes(gone), `设置里不该再出现「${gone}」`);
    }
  });

  check('报表编辑器：选中一份报表后 Markdown 预览正确渲染', () => {
    // ReportsTab 的 hook 顺序：0..5 是筛选项，6=selected、7=draft、8=editing
    const { text, effectErrors } = renderPage('reports', {
      ReportsTab: { 7: views.report, 8: views.report.content, 9: false },
    });
    assert.equal(effectErrors.length, 0, effectErrors.map((e) => e.message).join('; '));
    assert.ok(text.includes('归档'), '缺少归档按钮');
    // 这几个按钮按真机要求去掉了（注意「已定稿」是状态徽标，不是按钮）
    const labels = collectButtons(renderPage('reports', { ReportsTab: { 7: views.report, 8: views.report.content, 9: false } }).tree);
    for (const gone of ['定稿', '修订', '重渲染', '导出 .md']) {
      assert.ok(!labels.includes(gone), `不该再出现「${gone}」按钮，现有：${JSON.stringify(labels)}`);
    }
    // 没改过内容时不该出现「保存」
    assert.ok(!labels.includes('保存'), '没改动时不该一直显示保存按钮');
    assert.ok(/周报/.test(text), 'Markdown 预览没有渲染出标题');
    assert.ok(/本周总结/.test(text), 'Markdown 预览没有渲染出章节');
  });

  check('改了内容才出现「保存」，改回原样又消失', () => {
    const api = fakeApi('reports', views.reports);
    react.presets({
      ReportsTab: { 7: views.report, 8: views.report.content, 9: true },
    });
    const element = react.createElement(slots.main.component, { api });
    const clean = react.render(element).tree;
    assert.ok(!collectButtons(clean).includes('保存'), '未改动时不该有「保存」');
  });

  check('周报预览保留单换行（一行一件事，不能被撑成空行密布）', () => {
    const { tree } = renderPage('reports', {
      ReportsTab: { 7: views.report, 8: views.report.content, 9: false },
    });
    const md = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-md');
    assert.ok(md, '找不到预览区');
    const breaks = countIn(md, (n) => n.type === 'br');
    const paragraphs = countIn(md, (n) => n.type === 'p');
    assert.ok(breaks > 0, '预览里一个 <br> 都没有，单换行被吃掉了');
    // 周报正文没有空行，所以整块应当只被切成「本周完成：…」+「下周待办：…」两段
    assert.ok(paragraphs <= 2, `周报不该被切成 ${paragraphs} 段`);
  });

  check('空数据也不崩（所有视图为空时）', () => {
    const empty = {
      today: { date: '2026-10-12', weekday: '一', weekLabel: 'x', kind: 'workday', holidayName: '', stats: { openCount: 0, plannedCount: 0, doneCount: 0, weekDoneCount: 0, historyDoneCount: 0, overdueCount: 0, progress: 0 }, todos: [], overdue: [], done: [], weekDone: [], historyDone: [], historyTotal: 0, dropped: [], week: { from: '2026-10-12', to: '2026-10-18', week: 42, year: 2026 }, logs: [], projects: [], warnings: [] },
      todos: { total: 0, counts: { open: 0, done: 0, dropped: 0 }, tags: [], todos: [] },
      projects: [],
      reports: { total: 0, counts: { draft: 0, final: 0, archived: 0 }, projects: [], reports: [] },
      stats: { dim: 'month', from: '2026-01-01', to: '2026-12-31', projectId: null, buckets: [], totals: { done: 0, created: 0, dropped: 0, missed: 0, planned: 0, completionRate: 0 }, heatmap: null },
    };
    const saved = {};
    for (const key of Object.keys(empty)) saved[key] = views[key];
    Object.assign(views, empty);
    try {
      for (const tab of ['today', 'projects', 'reports', 'stats']) {
        const { effectErrors } = renderPage(tab);
        assert.equal(effectErrors.length, 0, `${tab} 副作用抛错：${effectErrors.map((e) => e.message).join('; ')}`);
      }
    } finally {
      // 一定要恢复，否则后面所有用例都会拿到这份空数据（曾经就这样连锁失败过）
      Object.assign(views, saved);
    }
  });
}

group('3b. 今日页只有三节，且完全不涉及工时');
{
  check('今日页只有「今日待办 / 本周完成 / 历史完成」三节，新增待办收进弹层', () => {
    const { text } = renderPage('today');
    for (const title of ['今日待办', '本周完成', '历史完成']) {
      assert.ok(text.includes(title), `缺少「${title}」`);
    }
    // 新增入口是「今日待办」节头上的按钮，不再是独立一节
    assert.ok(text.includes('新增'), '缺少「新增」入口');
    for (const gone of ['本月工时', '今日工时', '随手记']) {
      assert.ok(!text.includes(gone), `今日页不该再出现「${gone}」`);
    }
  });

  check('今日页的面板里不出现任何工时内容', () => {
    const { tree } = renderPage('today');
    // 只检查 .aw-board 内部：页面副标题「待办 · 报表 · 统计」属于全局抬头，不算今日页内容
    const boardText = (function find(node) {
      if (!node) return null;
      if (node.type === 'div' && node.props?.className === 'aw-board') return textOf(node);
      for (const child of node.children || []) {
        const hit = find(child);
        if (hit !== null) return hit;
      }
      return null;
    })(tree) || '';
    assert.ok(boardText.length > 0, '没找到面板');
    assert.doesNotMatch(boardText, /工时/, '今日页面板里不该出现「工时」');
  });

}

group('3b2. 顶部与今日页的冗余 chip 已去掉');
{
  /** 取页面上所有 chip 的文案。 */
  function chipTexts(tree) {
    const out = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === 'span' && /aw-chip/.test(node.props?.className || '')) out.push(textOf(node).replace(/\s+/g, ' ').trim());
      for (const child of node.children || []) walk(child);
    })(tree);
    return out;
  }

  check('顶部状态栏没有「日需」，侧栏 promo 回答「今天做什么」', () => {
    const { tree } = renderPage('today');
    const chips = chipTexts(tree);
    assert.ok(!chips.some((c) => c.startsWith('日需')), `不该再有日需 chip：${JSON.stringify(chips)}`);
    // 侧栏 promo 卡展示今日待办与完成进度
    const text = textOf(tree);
    assert.match(text, /今日待办\s+\d+\s*项/, '今日待办的数量应当保留');
    assert.match(text, /完成\s+\d+/, '今日完成的数量应当保留');
  });

  check('今日页没有「法定工作日」chip，底部概览数字仍在', () => {
    const { tree } = renderPage('today');
    const chips = chipTexts(tree);
    assert.ok(!chips.includes('💼 法定工作日'), `不该再有法定工作日 chip：${JSON.stringify(chips)}`);
    // 重构后底部概览是一行说明文字，不再用胶囊 —— 这两个数必须还在
    const text = textOf(tree);
    assert.match(text, /今日待办\s+\d+/, '今日待办的数量应当保留');
    assert.match(text, /本周完成\s+\d+/, '本周完成的数量应当保留');
  });

  check('逾期提醒保留', () => {
    const { text } = renderPage('today');
    assert.match(text, /逾期\s+\d+/, '逾期属于风险，仍然要在页面上出现');
  });

  check('月底提醒不再提「批量填报」（那个功能已经没了）', () => {
    const { text } = renderPage('today');
    assert.ok(!text.includes('批量填报'), '不该再提批量填报');
  });
}

group('3c. 优先级 P0~P3 的含义必须写在界面上');
{
  check('新增弹层里的优先级下拉带含义，而不是光秃秃的 P0/P1/P2/P3', () => {
    // TodayTab 的 hook：0 showAllHistory / 1 editing / 2 adding / 3 dirty / 4 confirmClose
    const { text } = renderPage('today', { TodayTab: { 2: true } });
    for (const label of ['P0 · 重要且紧急', 'P1 · 重要不紧急', 'P2 · 紧急不重要', 'P3 · 不重要不紧急']) {
      assert.ok(text.includes(label), `下拉里缺少「${label}」`);
    }
    assert.ok(
      text.includes('优先级：P0 重要且紧急 · P1 重要不紧急 · P2 紧急不重要 · P3 不重要不紧急'),
      '缺少图例',
    );
  });

  check('待办行的优先级徽标带悬浮说明', () => {
    const { tree } = renderPage('today');
    const badges = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === 'span' && node.props && /^aw-prio( |$)/.test(String(node.props.className))) badges.push(node.props);
      for (const child of node.children || []) walk(child);
    })(tree);
    assert.ok(badges.length > 0, '一个优先级徽标都没有');
    assert.ok(
      badges.every(
        (badge) =>
          typeof badge.title === 'string' &&
          /^P[0-3] (重要且紧急|重要不紧急|紧急不重要|不重要不紧急)/.test(badge.title),
      ),
      `徽标缺少含义提示：${JSON.stringify(badges.map((b) => b.title))}`,
    );
  });

  check('优先级也带简称，一眼能看懂', () => {
    const { tree } = renderPage('today');
    let labelCount = 0;
    (function walk(node) {
      if (!node) return;
      if (node.type === 'span' && node.props && node.props.className === 'aw-prio-label') labelCount += 1;
      for (const child of node.children || []) walk(child);
    })(tree);
    assert.ok(labelCount > 0, '徽标里没有简称');
  });
}

group('3j. 看板页：四象限、卡片与分类口径');
{
  const QUADRANTS = [
    ['P0', '重要且紧急', '立即做'],
    ['P1', '重要不紧急', '排期做'],
    ['P2', '紧急不重要', '委派或批量处理'],
    ['P3', '不重要不紧急', '删除或归档'],
  ];

  const cls = (node) => String(node?.props?.className || '');
  function collect(tree, predicate) {
    const out = [];
    (function walk(node) {
      if (!node) return;
      if (predicate(node)) out.push(node);
      for (const child of node.children || []) walk(child);
    })(tree);
    return out;
  }
  const quadrantsOf = (tree) => collect(tree, (n) => n.type === 'section' && /(^| )aw-q( |$)/.test(cls(n)));
  const cardsOf = (tree) => collect(tree, (n) => cls(n).split(' ')[0] === 'aw-kcard');
  const quadrantOf = (tree, priority) => findNode(tree, (n) => n.type === 'section' && n.props && n.props['data-q'] === priority);

  check('四个象限按 P0~P3 排布：标题 + 副标题 + 计数都来自视图', () => {
    const { tree, effectErrors } = renderPage('board');
    assert.equal(effectErrors.length, 0, `渲染副作用抛错：${effectErrors.map((e) => e.message).join('; ')}`);
    const quadrants = quadrantsOf(tree);
    assert.equal(quadrants.length, 4, '看板应当正好四个象限');
    quadrants.forEach((node, index) => {
      const [priority, title, sub] = QUADRANTS[index];
      assert.equal(node.props['data-q'], priority, `第 ${index + 1} 个象限应当是 ${priority}`);
      assert.equal(textOf(findNode(node, (n) => cls(n) === 'aw-q-title')), title, `${priority} 的标题不对`);
      assert.equal(textOf(findNode(node, (n) => cls(n) === 'aw-q-sub')), sub, `${priority} 的副标题不对`);
      const badge = findNode(node, (n) => cls(n) === 'aw-q-badge');
      assert.ok(badge, `${priority} 缺少计数`);
      assert.equal(textOf(badge), `${views.board.quadrants[index].count} 项`);
    });
    assert.ok(views.board.quadrants[1].count > 0, '前置条件：P1 象限应当有卡片');
  });

  check('卡片只露标题与截止日（没有优先级、象限名、进度）', () => {
    const { tree } = renderPage('board');
    const cards = cardsOf(tree);
    assert.equal(cards.length, views.board.total, `卡片数应当等于视图里的未完成总数（${views.board.total}）`);
    const all = cards.map(textOf).join('|');
    assert.ok(all.includes('对账系统灰度方案设计'), 'P1 的卡片没渲染出来');
    assert.ok(all.includes('2026-10-09 截止'), '有截止日的卡片要显示日期');
    assert.ok(all.includes('暂无截止'), '没有截止日的卡片要有兜底文案');
    for (const card of cards) {
      const text = textOf(card);
      assert.ok(!/P[0-3]/.test(text), `卡片上不该出现优先级代码：${text}`);
      assert.ok(!text.includes('重要且紧急') && !text.includes('排期做'), `卡片上不该出现象限名：${text}`);
      assert.ok(!/%/.test(text), `卡片上不该出现完成度：${text}`);
    }
    assert.equal(collect(tree, (n) => /^aw-prio( |$)/.test(cls(n))).length, 0, '看板不用今日页的优先级徽标');
  });

  check('逾期卡片的截止日用轻红，未逾期的保持中性', () => {
    const { tree } = renderPage('board');
    const overdue = cardsOf(tree).find((card) => textOf(card).includes('2026-10-09 截止'));
    assert.ok(overdue, '前置条件：应当有一条 10-09 截止的卡片');
    const due = findNode(overdue, (n) => cls(n).startsWith('aw-kcard-due'));
    assert.match(cls(due), /is-overdue/, '逾期的截止日要有警示色');
    const none = cardsOf(tree).find((card) => textOf(card).includes('暂无截止'));
    assert.ok(none, '前置条件：应当有一条没有截止日的卡片');
    assert.doesNotMatch(cls(findNode(none, (n) => cls(n).startsWith('aw-kcard-due'))), /is-overdue/);
  });

  check('每个象限都有「+」，点开就是该象限的新建弹层', () => {
    const api = fakeApi('board', views.board);
    react.presets({ WorkPage: { 2: 'board' } });
    const element = react.createElement(slots.main.component, { api });
    let tree = react.render(element).tree;
    const add = findNode(tree, (n) => n.type === 'button' && n.props?.['aria-label'] === '在「紧急不重要」新建');
    assert.ok(add, '象限标题栏缺少「+」');
    add.props.onClick();
    tree = react.render(element).tree;
    const modal = findNode(tree, (n) => cls(n) === 'aw-modal');
    assert.ok(modal, '点「+」没有打开新建弹层');
    assert.equal(textOf(findNode(modal, (n) => n.type === 'h3')).trim(), '新建待办', '弹窗标题只写「新建待办」，不带象限名');
    const locked = findNode(modal, (n) => n.type === 'select' && n.props?.value === 'P2');
    assert.ok(locked, '新建弹层里应当能看到落到哪个优先级');
    assert.equal(locked.props.disabled, true, '从象限「+」进来，优先级应锁定为 P2 不可改');
    const title = findNode(modal, (n) => n.type === 'input' && n.props?.placeholder === '待办标题');
    assert.ok(title, '弹层里缺少标题输入');
    title.props.onChange({ target: { value: '催对账数据' } });
    tree = react.render(element).tree;
    const ready = findNode(tree, (n) => cls(n) === 'aw-modal');
    const submit = findNode(ready, (n) => n.type === 'button' && textOf(n).trim() === '新建');
    assert.ok(submit, '弹层里缺少「新建」按钮');
    submit.props.onClick();
    const creates = api.calls.filter((call) => call[0] === 'send' && call[1] === 'todo_create');
    assert.equal(creates.length, 1, `应当只发一次 todo_create：${JSON.stringify(api.calls)}`);
    assert.equal(creates[0][2].priority, 'P2', '从「紧急不重要」的 + 进来，默认就是 P2');
  });

  check('切换「仅个人」：一次请求同时记住设置并刷新看板', () => {
    const { tree, api } = renderPage('board');
    const personal = findNode(tree, (n) => n.type === 'button' && textOf(n).trim() === '仅个人');
    assert.ok(personal, '看板右上角缺少分类切换');
    personal.props.onClick();
    const updates = api.calls.filter((call) => call[0] === 'send' && call[1] === 'settings_update');
    assert.equal(updates.length, 1, `应当只发一次 settings_update：${JSON.stringify(api.calls)}`);
    assert.deepEqual(updates[0][2], {
      settings: { boardCategory: 'personal' },
      view: 'board',
      viewParams: { category: 'personal' },
    });
    assert.equal(updates[0][3] && updates[0][3].silent, true, '切口径不该再弹一条全局提示');
    const seg = findNode(tree, (n) => cls(n) === 'aw-kb-scope');
    assert.ok(seg, '分类切换应当是分段按钮');
    assert.deepEqual(
      (seg.children || []).filter((n) => n.type === 'button').map((n) => textOf(n).trim()),
      ['全部', '仅工作', '仅个人'],
    );
    const on = findNode(seg, (n) => cls(n).includes('is-on'));
    assert.equal(textOf(on).trim(), '全部', '默认口径是全部');
  });

  check('打开插件默认落在看板，而不是今日', () => {
    react.presets({});
    const api = fakeApi('board', views.board);
    const { tree } = react.render(react.createElement(slots.main.component, { api }));
    const on = findNode(tree, (n) => n.type === 'button' && cls(n).includes('aw-tab') && cls(n).includes('is-on'));
    assert.ok(on, '找不到当前分页');
    assert.equal(textOf(on).trim(), '看板', '默认分页应当是看板');
    assert.ok(findNode(tree, (n) => cls(n) === 'aw-kb'), '默认应当直接渲染看板页');
    const opens = api.calls.filter((call) => call[0] === 'open' && call[1] === 'board');
    assert.equal(opens.length, 1, `默认进看板应当拉一次 board 视图：${JSON.stringify(api.calls)}`);
  });

  check('看板分页按记住的分类口径拉数据', () => {
    const { api } = renderPage('board');
    const opens = api.calls.filter((call) => call[0] === 'open' && call[1] === 'board');
    assert.equal(opens.length, 1, `进入看板应当只拉一次 board 视图：${JSON.stringify(api.calls)}`);
    assert.deepEqual(opens[0][2], { category: 'all' }, '要按记住的分类口径拉');
  });

  check('拖拽中：目标象限虚线高亮 + 落点提示，源卡片跟着指针走', () => {
    const dragged = views.board.quadrants[1].todos[0];
    const { tree } = renderPage('board', {
      BoardTab: {
        1: {
          id: dragged.id,
          title: dragged.title,
          fromPriority: 'P1',
          fromIndex: 0,
          x: 120,
          y: 240,
          grabX: 90,
          grabY: 14,
          width: 320,
          target: { priority: 'P0', index: 0 },
        },
      },
    });
    const p0 = quadrantOf(tree, 'P0');
    assert.match(cls(p0), /is-over/, '拖入的象限要有高亮');
    assert.ok(textOf(p0).includes('松开鼠标，放到这里'), '目标象限要有落点提示');
    const p1 = quadrantOf(tree, 'P1');
    assert.ok(!textOf(p1).includes(dragged.title), '拖动中的卡片应当离开原位');
    assert.ok(textOf(tree).includes(dragged.title), '拖动中的卡片要跟着指针（ghost）');
    const ghost = findNode(tree, (n) => /^aw-kb-ghost( |$)/.test(cls(n)));
    assert.ok(ghost, '缺少拖拽中的浮层');
    // 浮卡必须保持「按下时抓住的那个位置」在指针下：不是固定偏移，也不能跳
    assert.equal(Number(ghost.props.style.left), 120 - 90, `浮卡横向偏离指针：${ghost.props.style.left}`);
    assert.equal(Number(ghost.props.style.top), 240 - 14, `浮卡纵向偏离指针：${ghost.props.style.top}`);
  });

  check('单击只是选中：卡片上不冒出完成 / 编辑 / 删除按钮', () => {
    const target = views.board.quadrants[1].todos[0];
    const { tree } = renderPage('board', { BoardTab: { 0: target.id } });
    const card = cardsOf(tree).find((n) => n.props && n.props['data-card-id'] === target.id);
    assert.ok(card, '找不到被选中的卡片');
    assert.match(cls(card), /is-sel/, '选中要有视觉反馈');
    assert.equal(collect(card, (n) => n.type === 'button').length, 0, '卡片里不该再冒出按钮');
    assert.ok(!textOf(card).includes('编辑') && !textOf(card).includes('删除'), '卡片文案不该出现编辑 / 删除');
  });

  check('单击空白处取消选中', () => {
    const target = views.board.quadrants[1].todos[0];
    const api = fakeApi('board', views.board);
    react.presets({ WorkPage: { 2: 'board' }, BoardTab: { 0: target.id } });
    const element = react.createElement(slots.main.component, { api });
    let tree = react.render(element).tree;
    assert.equal(collect(tree, (n) => n.props && n.props['data-card-id'] === target.id && cls(n).includes('is-sel')).length, 1, '前置条件：卡片已选中');
    const root = findNode(tree, (n) => cls(n) === 'aw-kb');
    assert.ok(root && typeof root.props.onPointerDown === 'function', '看板根节点要能响应空白处按下');
    root.props.onPointerDown({ target: { closest: () => null } });
    tree = react.render(element).tree;
    assert.equal(collect(tree, (n) => cls(n).includes('is-sel')).length, 0, '点空白处应当取消选中');
  });

  check('落定提示带「撤销」，撤销走 todo_move', () => {
    const { tree, api } = renderPage('board', {
      BoardTab: { 3: { text: '已移至【重要且紧急】', undo: { id: 'todo-x', priority: 'P1', index: 0 } } },
    });
    assert.ok(textOf(tree).includes('已移至【重要且紧急】'), '移动后要有轻微提示');
    const undo = findNode(tree, (n) => n.type === 'button' && textOf(n).trim() === '撤销');
    assert.ok(undo, '提示里要有「撤销」兜底');
    undo.props.onClick();
    const moves = api.calls.filter((call) => call[0] === 'send' && call[1] === 'todo_move');
    assert.equal(moves.length, 1, `撤销应当发一次 todo_move：${JSON.stringify(api.calls)}`);
    assert.deepEqual(moves[0][2], { id: 'todo-x', priority: 'P1', index: 0 });
    assert.equal(moves[0][3] && moves[0][3].silent, true, '撤销不该再弹一条全局提示');
  });

  check('看板 CSS：2×2 网格、虚线闪烁、克制但活泼的动画', () => {
    const css = cssOf(renderPage('board').tree) || '';
    for (const rule of [
      '.aw-kb-grid{',
      '.aw-q{',
      '.aw-q.is-over::after{',
      '.aw-q-drop{',
      '.aw-kcard{',
      '.aw-kcard.is-landed{',
      '.aw-kb-toast{',
      '.aw-kb-ghost{',
    ]) {
      assert.ok(css.includes(rule), `缺少 ${rule} —— 看板会丢功能`);
    }
    const grid = (css.match(/^\.aw-kb-grid\{[^}]*\}/m) || [])[0];
    assert.match(grid, /grid-template-columns:1fr 1fr/, `看板是 2×2：${grid}`);
    assert.match(grid, /grid-template-rows:1fr 1fr/, grid);
    const over = (css.match(/^\.aw-q\.is-over::after\{[^}]*\}/m) || [])[0];
    assert.match(over, /dashed/, '拖入提示要用虚线');
    assert.match(over, /animation:awPulse/, '虚线要闪，用户才知道可以松手');
    assert.match(css, /@keyframes awPulse\{/, '缺少闪烁动画');
    assert.match(css, /^\.aw-kcard\.is-landed\{[^}]*animation:awLand/m, '松手要有轻微反馈');
    for (const token of ['--q0:', '--q1:', '--q2:', '--q3:']) {
      assert.ok(css.includes(token), `皮肤里缺少 ${token}（四象限配色）`);
    }
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{\.aw-kcard,/, '减弱动效时应当关掉动画');
    // 卡片高度照参考稿 38px，象限内滚动而不是把页面撑长
    assert.match(css, /^\.aw-kcard\{[^}]*height:38px/m, '卡片高度应当与参考稿一致');
    assert.match(css, /^\.aw-q-list\{[^}]*overflow-y:auto/m, '象限内应当自己滚动');
  });

  check('左栏「看板」在「今日」上方，图标是四宫格', () => {
    const { tree } = renderPage('today');
    const nav = findNode(tree, (n) => n.type === 'nav' && cls(n) === 'aw-tabs');
    assert.ok(nav, '找不到左栏导航');
    const buttons = (nav.children || []).filter((n) => n.type === 'button');
    assert.deepEqual(
      buttons.map((n) => textOf(n).trim()),
      ['看板', '今日', '项目', '简报', '统计'],
      '「看板」应当是「今日」上面的一级分页',
    );
    const boardTab = buttons[0];
    const pathCount = collect(findNode(boardTab, (n) => n.type === 'svg'), (n) => n.type === 'path').length;
    assert.equal(pathCount, 4, '看板图标是四宫格');
  });
}

group('3c2. 新增待办弹层：× 关闭 + 纵向全宽表单');
{
  /** 打开「新增待办」弹层；extra 可预设 TodayTab 后续 hook（3=脏标记）。 */
  const openAdd = (extra = {}) => renderPage('today', { TodayTab: { 2: true, ...extra } });

  check('标题栏右上角有 × 关闭按钮', () => {
    const { tree } = openAdd();
    const modal = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-modal');
    assert.ok(modal, '没有找到新增待办弹层');
    const head = findNode(modal, (n) => n.type === 'div' && n.props?.className === 'aw-modal-head');
    assert.ok(head, '缺少标题栏容器');
    const close = findNode(head, (n) => n.type === 'button' && n.props?.['aria-label'] === '关闭');
    assert.ok(close, '标题栏缺少 × 关闭按钮');
    assert.ok(textOf(close).includes('×'), '关闭按钮应显示 × 图标');
  });

  check('表单改成一项一行：纵向容器 + 每项都有上方名称', () => {
    const { tree } = openAdd();
    const form = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-form-vertical');
    assert.ok(form, '缺少纵向表单容器');
    const fields = (form.children || []).filter((n) => n.type === 'div' && /aw-field/.test(n.props?.className || ''));
    assert.ok(fields.length >= 6, `应有至少 6 个字段，实际 ${fields.length}`);
    for (const label of ['待办标题', '说明', '所属项目', '优先级', '截止日期', '重复任务']) {
      assert.ok(textOf(form).includes(label), `缺少字段名称「${label}」`);
    }
  });

  check('「说明」是多行文本框，紧跟在标题下方', () => {
    const { tree } = openAdd();
    const form = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-form-vertical');
    const fields = (form.children || []).filter((n) => n.type === 'div' && /aw-field/.test(n.props?.className || ''));
    assert.ok(/说明/.test(textOf(fields[1])), '第二个字段应当是「说明」');
    const area = findNode(fields[1], (n) => n.type === 'textarea');
    assert.ok(area, '「说明」应当是 textarea');
    assert.equal(area.props.rows, 3, '说明应当给到 3 行');
    assert.ok(/补充背景、验收标准/.test(area.props.placeholder || ''), '说明需要占位提示');
  });

  check('填写说明后点「新建」，todo_create 带上 note', () => {
    const api = fakeApi('today', views.today);
    react.presets({ WorkPage: { 2: 'today' }, TodayTab: { 2: true } });
    const element = react.createElement(slots.main.component, { api });
    const findField = (node, predicate) => findNode(node, predicate);
    const modalOf = (tree) => findField(tree, (n) => n.type === 'div' && n.props?.className === 'aw-modal');

    const first = react.render(element).tree;
    findField(modalOf(first), (n) => n.type === 'input' && n.props?.placeholder === '待办标题')
      .props.onChange({ target: { value: '补一条说明' } });

    const filled = react.render(element).tree;
    const area = findField(modalOf(filled), (n) => n.type === 'textarea' && n.props?.className === 'aw-textarea');
    assert.ok(area, '找不到说明输入框');
    area.props.onChange({ target: { value: '先确认导出字段\n再对齐灰度节奏' } });

    const ready = react.render(element).tree;
    const submit = findField(modalOf(ready), (n) => n.type === 'button' && textOf(n).trim() === '新建');
    assert.ok(submit, '找不到「新建」按钮');
    assert.equal(submit.props.disabled, false, '标题非空时「新建」应当可用');
    submit.props.onClick();

    const creates = api.calls.filter((c) => c[0] === 'send' && c[1] === 'todo_create');
    assert.equal(creates.length, 1, `应当发一次 todo_create，实际：${JSON.stringify(api.calls)}`);
    assert.equal(creates[0][2].title, '补一条说明');
    assert.equal(creates[0][2].note, '先确认导出字段\n再对齐灰度节奏');
  });

  check('控件全宽，输入框不再带固定宽度', () => {
    const { tree } = openAdd();
    const css = cssOf(tree);
    assert.ok(/\.aw-form-vertical \.aw-input,\s*\.aw-form-vertical \.aw-select\{width:100%\}/.test(css), '缺少全宽样式');
    const form = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-form-vertical');
    const inputs = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === 'input' && /aw-input/.test(node.props?.className || '')) inputs.push(node.props);
      for (const child of node.children || []) walk(child);
    })(form);
    assert.ok(inputs.length > 0, '没有输入框');
    assert.ok(inputs.every((p) => !p.style || !p.style.width), `还有固定宽度的输入框：${JSON.stringify(inputs.map((p) => p.style))}`);
  });

  check('「新建」按钮独占一行，优先级图例在它下方', () => {
    const { tree } = openAdd();
    const form = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-form-vertical');
    const kids = form.children || [];
    const submitIdx = kids.findIndex((n) => n.type === 'div' && n.props?.className === 'aw-submit-wrap');
    const noteIdx = kids.findIndex((n) => n.type === 'span' && n.props?.className === 'aw-note');
    assert.ok(submitIdx >= 0, '缺少全宽提交按钮容器');
    assert.ok(noteIdx > submitIdx, '优先级图例应在提交按钮下方');
  });

  /** 找到弹层标题栏的 × 按钮。 */
  const closeButton = (tree) => findNode(tree, (n) => n.type === 'button' && n.props?.['aria-label'] === '关闭');

  check('点 × 时：干净表单直接关闭', () => {
    const first = renderPage('today', { TodayTab: { 2: true } });
    const close = closeButton(first.tree);
    assert.ok(close, '缺少 × 按钮');
    close.props.onClick();
    // 不重置实例再渲染一次，才能读到 setter 写入的新状态
    const after = react.render(react.createElement(slots.main.component, { api: first.api }));
    assert.ok(!textOf(after.tree).includes('新增待办'), '干净表单点 × 应直接关闭');
  });

  check('点 × 时：脏表单先弹确认，放弃填写才真正关闭', () => {
    const first = renderPage('today', { TodayTab: { 2: true, 3: true } });
    assert.ok(!first.text.includes('确认放弃填写？'), '没点 × 之前不该弹确认');
    closeButton(first.tree).props.onClick();
    const after = react.render(react.createElement(slots.main.component, { api: first.api }));
    const text = textOf(after.tree);
    assert.ok(text.includes('已填写的内容尚未保存，确认放弃填写？'), '脏表单点 × 应弹确认');
    assert.ok(text.includes('放弃填写') && text.includes('继续填写'), '确认条缺少操作按钮');

    const giveUp = findNode(after.tree, (n) => n.type === 'button' && textOf(n).trim() === '放弃填写');
    giveUp.props.onClick();
    const closed = react.render(react.createElement(slots.main.component, { api: first.api }));
    assert.ok(!textOf(closed.tree).includes('新增待办'), '放弃填写后弹层应关闭');
  });
}

group('3e. 今日页只保留一块面板，各节用分割线');
{
  /** 收集某一类节点的数量。 */
  function countNodes(tree, predicate) {
    let n = 0;
    (function walk(node) {
      if (!node) return;
      if (predicate(node)) n += 1;
      for (const child of node.children || []) walk(child);
    })(tree);
    return n;
  }

  check('今日页只有 1 块带边框的面板，且正好切成三节', () => {
    const { tree } = renderPage('today');
    const boards = countNodes(tree, (n) => n.type === 'div' && n.props?.className === 'aw-board');
    const secs = countNodes(tree, (n) => n.type === 'section' && /aw-sec/.test(n.props?.className || ''));
    assert.equal(boards, 1, '今日页应当只有一块面板');
    // 今日待办 / 本周完成 / 历史完成（新增待办已收进弹层）
    assert.equal(secs, 3, `应当正好是三节，实际 ${secs} 节`);
  });

  check('今日页不再一节一个卡片', () => {
    const { tree } = renderPage('today');
    const cards = countNodes(tree, (n) => n.type === 'div' && /aw-card/.test(n.props?.className || ''));
    assert.equal(cards, 0, `今日页还剩 ${cards} 个卡片，边框会太密`);
  });

  check('分割线规则：节与节之间有细线，首节没有', () => {
    const { tree } = renderPage('today');
    const css = cssOf(tree);
    assert.match(css, /^\.aw-sec\{[^}]*border-top:1px solid var\(--rule\)/m, '.aw-sec 缺少分割线');
    assert.match(css, /^\.aw-sec\.is-first\{border-top:0/m, '首节应当去掉分割线');
    assert.match(css, /^\.aw-board,\.aw-card\{[^}]*background:var\(--paper-2\)/m, '.aw-board 应当是白卡面');
  });

  check('积压概念已经下线：今日页没有折叠分组', () => {
    const { tree, text } = renderPage('today');
    assert.ok(!text.includes('积压'), '不该再出现积压文案');
    const folds = countNodes(tree, (n) => n.type === 'div' && n.props?.className === 'aw-fold');
    assert.equal(folds, 0, '不该再有折叠分组');
  });

  check('本周完成用实心打勾方块，而不是删除线', () => {
    const { tree, text } = renderPage('today');
    const checks = countNodes(tree, (n) => n.type === 'span' && n.props?.className === 'aw-check-done');
    assert.ok(checks > 0, '本周完成里没有绿色打勾');
    const css = cssOf(tree);
    assert.doesNotMatch(css, /text-decoration:line-through/, '完成的条目不该再用删除线');
    // 按 Pixso 参考稿：选中/完成一律是主色实心 + 白色勾
    assert.match(css, /^\.aw-check-done\{[^}]*background:var\(--accent\)/m, '打勾应当用主色填充');
    assert.match(css, /^\.aw-check-done\{[^}]*border-radius:var\(--r-check\)/m, '打勾圆角应当走 --r-check 令牌');
    assert.ok(text.includes('本周完成'), '缺少本周完成节');
  });
}

group('3c2. 今日待办的删除收在 ⋯ 菜单里（排在「放弃」后面，两步确认）');
{
  /** 展开 Menu，返回渲染出来的按钮文案。 */
  function openMenu(element) {
    const first = react.render(element).tree;
    const more = findNode(first, (n) => n.type === 'button' && textOf(n).trim() === '⋯');
    assert.ok(more, '找不到 ⋯ 按钮');
    more.props.onClick();
    return react.render(element).tree;
  }

  function clickLabel(tree, label) {
    const node = findNode(tree, (n) => n.type === 'button' && textOf(n).trim() === label);
    assert.ok(node, `找不到「${label}」按钮，现有：${JSON.stringify(collectButtons(tree))}`);
    node.props.onClick();
  }

  check('行内只有一个 ⋯，删除在菜单里且排在「放弃」后面', () => {
    const api = fakeApi('today', views.today);
    react.presets({ WorkPage: { 2: 'today' } });
    const element = react.createElement(slots.main.component, { api });

    // 收起状态：行内不该有「删除」
    const closed = react.render(element).tree;
    const closedLabels = collectButtons(closed);
    assert.ok(!closedLabels.includes('删除'), `收起时不该直接露出删除：${JSON.stringify(closedLabels)}`);
    assert.ok(closedLabels.includes('⋯'));

    // 展开后：编辑 / 进度 / 放弃 / 删除（推到明天、今天做、转积压已随计划日一起下线）
    const opened = openMenu(element);
    const labels = collectButtons(opened);
    for (const want of ['编辑', '进度', '放弃', '删除']) {
      assert.ok(labels.includes(want), `菜单里缺少「${want}」：${JSON.stringify(labels)}`);
    }
    for (const gone of ['推到明天', '今天做', '转积压']) {
      assert.ok(!labels.includes(gone), `「${gone}」已经下线，不该再出现：${JSON.stringify(labels)}`);
    }
    assert.ok(
      labels.indexOf('删除') > labels.indexOf('放弃'),
      `「删除」应当排在「放弃」后面，实际：${JSON.stringify(labels)}`,
    );
  });

  check('点菜单里的「删除」不立刻删，先要确认；确认后只发一次 todo_delete', () => {
    const api = fakeApi('today', views.today);
    react.presets({ WorkPage: { 2: 'today' } });
    const element = react.createElement(slots.main.component, { api });

    const opened = openMenu(element);
    clickLabel(opened, '删除');

    const confirming = react.render(element).tree;
    const labels = collectButtons(confirming);
    assert.ok(labels.includes('确认删除'), `应当出现确认按钮：${JSON.stringify(labels)}`);
    assert.ok(labels.includes('取消'));
    assert.equal(
      api.calls.filter((c) => c[0] === 'send').length,
      0,
      '仅仅点了「删除」不该发出任何写请求',
    );

    clickLabel(confirming, '确认删除');
    const deletes = api.calls.filter((c) => c[0] === 'send' && c[1] === 'todo_delete');
    assert.equal(deletes.length, 1, `确认后应当调用一次 todo_delete，实际：${JSON.stringify(api.calls)}`);
    assert.ok(deletes[0][2] && deletes[0][2].id, 'todo_delete 必须带上待办 id');
  });

  check('点「取消」退回菜单原来的那排按钮', () => {
    const api = fakeApi('today', views.today);
    react.presets({ WorkPage: { 2: 'today' } });
    const element = react.createElement(slots.main.component, { api });

    clickLabel(openMenu(element), '删除');
    const confirming = react.render(element).tree;
    clickLabel(confirming, '取消');

    const back = react.render(element).tree;
    const labels = collectButtons(back);
    assert.ok(!labels.includes('确认删除'), '取消后不该还留着确认按钮');
    assert.ok(labels.includes('放弃'), '取消后应当回到菜单');
    assert.ok(labels.includes('删除'), '取消后应当还能再点删除');
  });
}

group('3c3. 完成度：行内可见、可在 ⋯ 里改');
{
  check('进行中的待办在行内显示完成度', () => {
    const { text } = renderPage('today');
    assert.ok(text.includes('40%'), '行内应当显示 40%');
  });

  check('⋯ 菜单里有「进度」，点了能改并调用 todo_update', () => {
    const api = fakeApi('today', views.today);
    react.presets({ WorkPage: { 2: 'today' } });
    const element = react.createElement(slots.main.component, { api });

    const first = react.render(element).tree;
    const more = findNode(first, (n) => n.type === 'button' && textOf(n).trim() === '⋯');
    assert.ok(more, '找不到 ⋯');
    more.props.onClick();

    const menu = react.render(element).tree;
    const progressBtn = findNode(menu, (n) => n.type === 'button' && textOf(n).trim() === '进度');
    assert.ok(progressBtn, `菜单里缺少「进度」：${JSON.stringify(collectButtons(menu))}`);
    progressBtn.props.onClick();

    const editing = react.render(element).tree;
    const input = findNode(editing, (n) => n.type === 'input' && n.props?.type === 'number');
    assert.ok(input, '没出现进度输入框');
    input.props.onChange({ target: { value: '65' } });

    const after = react.render(element).tree;
    const save = findNode(after, (n) => n.type === 'button' && textOf(n).trim() === '保存');
    assert.ok(save, '没出现保存按钮');
    save.props.onClick();

    const updates = api.calls.filter((c) => c[0] === 'send' && c[1] === 'todo_update');
    assert.equal(updates.length, 1, `应当调用一次 todo_update，实际：${JSON.stringify(api.calls)}`);
    assert.equal(updates[0][2].progress, 65);
    assert.ok(updates[0][2].id, 'todo_update 必须带 id');
  });
}

group('3c4. 待办可以修改（未完成 / 已完成都支持）');
{
  function openEditor(api) {
    react.presets({ WorkPage: { 2: 'today' } });
    const element = react.createElement(slots.main.component, { api });
    const first = react.render(element).tree;
    // ⋯ → 编辑
    findNode(first, (n) => n.type === 'button' && textOf(n).trim() === '⋯').props.onClick();
    const menu = react.render(element).tree;
    const edit = findNode(menu, (n) => n.type === 'button' && textOf(n).trim() === '编辑');
    assert.ok(edit, `菜单里缺少「编辑」：${JSON.stringify(collectButtons(menu))}`);
    edit.props.onClick();
    return { element, tree: react.render(element).tree };
  }

  check('⋯ 菜单里有「编辑」，点开是修改弹层', () => {
    const api = fakeApi('today', views.today);
    const { tree } = openEditor(api);
    const text = textOf(tree);
    assert.ok(text.includes('修改待办'), '没出现修改弹层');
    // 字段齐全
    for (const label of ['标题', '说明', '项目', '优先级', '截止日', '完成度']) {
      assert.ok(text.includes(label), `弹层缺少「${label}」`);
    }
    assert.equal(api.calls.filter((c) => c[0] === 'send').length, 0, '只是打开弹层不该发请求');
  });

  check('改标题后保存，只发一次 todo_update 且带上新标题与 id', () => {
    const api = fakeApi('today', views.today);
    const { element, tree } = openEditor(api);
    const modal = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-modal');
    assert.ok(modal, '找不到弹层');
    const titleInput = findNode(modal, (n) => n.type === 'input' && n.props?.className === 'aw-input' && n.props?.type === undefined);
    assert.ok(titleInput, '找不到标题输入框');
    assert.equal(titleInput.props.value, '对账系统灰度方案设计', '标题输入框应当预填当前标题');
    titleInput.props.onChange({ target: { value: '改过的标题' } });

    const after = react.render(element).tree;
    const save = findNode(findNode(after, (n) => n.type === 'div' && n.props?.className === 'aw-modal'), (n) => n.type === 'button' && textOf(n).trim() === '保存');
    assert.ok(save, '找不到保存按钮');
    assert.equal(save.props.disabled, false, '标题非空时保存应当可用');
    save.props.onClick();

    const updates = api.calls.filter((c) => c[0] === 'send' && c[1] === 'todo_update');
    assert.equal(updates.length, 1, `应当只发一次 todo_update，实际：${JSON.stringify(api.calls)}`);
    assert.equal(updates[0][2].title, '改过的标题');
    assert.ok(updates[0][2].id, '必须带 id');
  });

  check('标题清空时保存按钮禁用（不许存空标题）', () => {
    const api = fakeApi('today', views.today);
    const { element, tree } = openEditor(api);
    const modal = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-modal');
    const titleInput = findNode(modal, (n) => n.type === 'input' && n.props?.className === 'aw-input' && n.props?.type === undefined);
    titleInput.props.onChange({ target: { value: '   ' } });
    const after = react.render(element).tree;
    const save = findNode(findNode(after, (n) => n.type === 'div' && n.props?.className === 'aw-modal'), (n) => n.type === 'button' && textOf(n).trim() === '保存');
    assert.equal(save.props.disabled, true, '空标题时保存必须禁用');
  });

  check('已完成的任务也能编辑，且完成度锁定为 100%', () => {
    const done = views.today.weekDone[0];
    assert.ok(done, '夹具里没有本周完成的条目');
    // 直接渲染弹层：hooks 顺序 0=draft
    const api = fakeApi('today', views.today);
    react.presets({ WorkPage: { 2: 'today' } });
    const element = react.createElement(slots.main.component, { api });
    // 先把 editing 指向已完成的那条：点本周完成行里的「编辑」
    const first = react.render(element).tree;
    const edits = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === 'button' && textOf(node).trim() === '编辑') edits.push(node);
      for (const child of node.children || []) walk(child);
    })(first);
    assert.ok(edits.length >= 1, `本周完成行里也该有「编辑」，实际按钮数 ${edits.length}`);
    edits[edits.length - 1].props.onClick();
    const opened = react.render(element).tree;
    assert.ok(textOf(opened).includes('修改已完成的任务'), '已完成条目应当打开「修改已完成的任务」弹层');
  });
}

group('3c6. 项目页：能新建也能改');
{
  check('每个项目卡片都有「编辑」按钮', () => {
    const { tree } = renderPage('projects');
    const projects = views.projects;
    assert.ok(projects.length > 0, '夹具里没有项目');
    const edits = countIn(tree, (n) => n.type === 'button' && textOf(n).trim() === '编辑');
    assert.equal(edits, projects.length, `项目 ${projects.length} 个，编辑按钮 ${edits} 个`);
  });

  check('点「编辑」打开弹层，字段为 项目名 / 分类 / 状态 / 说明', () => {
    const api = fakeApi('projects', views.projects);
    react.presets({ WorkPage: { 2: 'projects' } });
    const element = react.createElement(slots.main.component, { api });

    const first = react.render(element).tree;
    const edit = findNode(first, (n) => n.type === 'button' && textOf(n).trim() === '编辑');
    assert.ok(edit, '找不到编辑按钮');
    edit.props.onClick();

    const opened = react.render(element).tree;
    const modal = findNode(opened, (n) => n.type === 'div' && n.props?.className === 'aw-modal');
    assert.ok(modal, '没打开弹层');
    assert.ok(textOf(modal).includes('修改项目'));
    const labels = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === 'label') labels.push(textOf(node).trim());
      for (const child of node.children || []) walk(child);
    })(modal);
    assert.deepEqual(labels, ['项目名', '分类', '状态', '说明'], `弹层字段不对：${JSON.stringify(labels)}`);
    const nameInput = findNode(modal, (n) => n.type === 'input' && n.props?.value === views.projects[0].name);
    assert.ok(nameInput, '项目名没有预填当前值');
  });

  check('改名后保存，只发一次 project_update 且带 id 与新名字', () => {
    const api = fakeApi('projects', views.projects);
    react.presets({ WorkPage: { 2: 'projects' } });
    const element = react.createElement(slots.main.component, { api });

    findNode(react.render(element).tree, (n) => n.type === 'button' && textOf(n).trim() === '编辑').props.onClick();
    const opened = react.render(element).tree;
    const modal = findNode(opened, (n) => n.type === 'div' && n.props?.className === 'aw-modal');
    const nameInput = findNode(modal, (n) => n.type === 'input' && n.props?.value === views.projects[0].name);
    nameInput.props.onChange({ target: { value: '改过的项目名' } });

    const after = react.render(element).tree;
    const save = findNode(findNode(after, (n) => n.props?.className === 'aw-modal'), (n) => n.type === 'button' && textOf(n).trim() === '保存');
    assert.equal(save.props.disabled, false);
    save.props.onClick();

    const updates = api.calls.filter((c) => c[0] === 'send' && c[1] === 'project_update');
    assert.equal(updates.length, 1, `应当只发一次，实际：${JSON.stringify(api.calls)}`);
    assert.equal(updates[0][2].name, '改过的项目名');
    assert.ok(updates[0][2].id, '必须带 id');
  });

  check('项目卡片改成宽栅格，指标用 chip 排（不再挤成一行字）', () => {
    const { tree } = renderPage('projects');
    const css = cssOf(tree);
    assert.match(css, /^\.aw-grid\{[^}]*minmax\(3[0-9]{2}px/m, '项目栅格应当放宽到 300px 以上');
    // 项目卡片上能看到分类
    const text = textOf(tree);
    assert.ok(text.includes('工作'), '项目卡片应当显示分类');
  });
}

group('3c7. 项目表单：新增按钮打开弹窗，字段为项目名 / 分类 / 状态 / 说明');
{
  /** 取弹层里的字段名。 */
  function labelsOf(node) {
    const out = [];
    (function walk(item) {
      if (!item) return;
      if (item.type === 'label') out.push(textOf(item).trim());
      for (const child of item.children || []) walk(child);
    })(node);
    return out;
  }

  /** 点顶栏「新增项目」打开弹窗。 */
  function openCreate(api) {
    react.presets({ WorkPage: { 2: 'projects' } });
    const element = react.createElement(slots.main.component, { api });
    const first = react.render(element).tree;
    const trigger = findNode(first, (n) => n.type === 'button' && textOf(n).trim() === '新增项目');
    assert.ok(trigger, '顶栏缺少「新增项目」按钮');
    trigger.props.onClick();
    const tree = react.render(element).tree;
    const modal = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-modal');
    assert.ok(modal, '点了「新增项目」却没打开弹窗');
    return { element, tree, modal };
  }

  /** 点卡片上的「编辑」打开弹窗。 */
  function openEdit(api) {
    react.presets({ WorkPage: { 2: 'projects' } });
    const element = react.createElement(slots.main.component, { api });
    findNode(react.render(element).tree, (n) => n.type === 'button' && textOf(n).trim() === '编辑').props.onClick();
    const tree = react.render(element).tree;
    const modal = findNode(tree, (n) => n.type === 'div' && n.props?.className === 'aw-modal');
    assert.ok(modal, '没打开弹层');
    return { element, modal };
  }

  check('新增弹窗只有 项目名 / 分类 / 状态 / 说明', () => {
    const { modal } = openCreate(fakeApi('projects', views.projects));
    assert.deepEqual(labelsOf(modal), ['项目名', '分类', '状态', '说明']);
    for (const gone of ['图标', '代号', '负责人', '启动日', '结束日']) {
      assert.ok(!labelsOf(modal).includes(gone), `新增弹窗不该再有「${gone}」`);
    }
  });

  check('编辑弹层字段与新增一致', () => {
    const { modal } = openEdit(fakeApi('projects', views.projects));
    assert.deepEqual(labelsOf(modal), ['项目名', '分类', '状态', '说明']);
    for (const gone of ['图标', '代号', '负责人', '启动日', '结束日']) {
      assert.ok(!labelsOf(modal).includes(gone), `编辑弹层不该再有「${gone}」`);
    }
  });

  check('保存时提交 name / category / description / status', () => {
    const api = fakeApi('projects', views.projects);
    react.presets({ WorkPage: { 2: 'projects' } });
    const element = react.createElement(slots.main.component, { api });
    findNode(react.render(element).tree, (n) => n.type === 'button' && textOf(n).trim() === '编辑').props.onClick();

    const opened = react.render(element).tree;
    const modal = findNode(opened, (n) => n.type === 'div' && n.props?.className === 'aw-modal');
    findNode(modal, (n) => n.type === 'input' && n.props?.value === views.projects[0].name).props.onChange({ target: { value: '改过的项目名' } });

    const after = react.render(element).tree;
    findNode(findNode(after, (n) => n.props?.className === 'aw-modal'), (n) => n.type === 'button' && textOf(n).trim() === '保存').props.onClick();

    const updates = api.calls.filter((c) => c[0] === 'send' && c[1] === 'project_update');
    assert.equal(updates.length, 1);
    const payload = updates[0][2];
    assert.equal(payload.name, '改过的项目名');
    assert.equal(payload.category, 'work');
    for (const gone of ['emoji', 'code', 'owner', 'startedAt', 'endedAt']) {
      assert.ok(!(gone in payload), `payload 里不该再带 ${gone}：${JSON.stringify(payload)}`);
    }
  });

  check('新建时提交 name / category / description / status', () => {
    const api = fakeApi('projects', views.projects);
    const { element, modal } = openCreate(api);
    findNode(modal, (n) => n.type === 'input').props.onChange({ target: { value: '新项目' } });
    const ready = react.render(element).tree;
    const readyModal = findNode(ready, (n) => n.type === 'div' && n.props?.className === 'aw-modal');
    findNode(readyModal, (n) => n.type === 'button' && textOf(n).trim() === '新建').props.onClick();

    const creates = api.calls.filter((c) => c[0] === 'send' && c[1] === 'project_create');
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0][2], { name: '新项目', category: 'work', description: '', status: 'active' });
  });
}

group('3g2. 分页条永远看得见');
{
  check('分页永远可见：桌面在左栏竖排，窄屏降级成常驻横条', () => {
    const css = cssOf(renderPage('today').tree) || '';
    const rail = (css.match(/^\.aw-rail\{[^}]*\}/m) || [])[0];
    assert.ok(rail, '找不到 .aw-rail 规则');
    assert.match(rail, /flex:0 0 232px/, `左栏应当固定宽度：${rail}`);
    // 窄屏时左栏变成贴顶的横条，分页不会跟着内容滚走
    const narrow = css.slice(css.indexOf('@media (max-width:1080px)'));
    assert.match(narrow, /\.aw-rail\{[^}]*position:sticky/m, '窄屏左栏应当贴顶常驻');
    assert.match(narrow, /\.aw-tabs\{flex-direction:row/, '窄屏分页应当横排');
  });

  check('五个分页一个不少，顺序固定', () => {
    const { tree } = renderPage('today');
    const labels = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === 'button' && /aw-tab( |$)/.test(String(node.props?.className || ''))) labels.push(textOf(node).trim());
      for (const child of node.children || []) walk(child);
    })(tree);
    assert.deepEqual(labels, ['看板', '今日', '项目', '简报', '统计']);
  });
}

group('3c8. 今日页「历史完成」');
{
  check('本周完成下面有一节「历史完成」，只列本周之前的', () => {
    const { tree, text } = renderPage('today');
    const secs = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === 'section' && /aw-sec/.test(node.props?.className || '')) secs.push(textOf(node).replace(/\s+/g, ' ').trim());
      for (const child of node.children || []) walk(child);
    })(tree);
    assert.equal(secs.length, 3, `应当是三节，实际 ${secs.length}`);
    assert.ok(secs[2].startsWith('历史完成'), `第三节应当是历史完成，实际：${secs[2].slice(0, 20)}`);
    assert.ok(text.includes('历史完成'), '缺少历史完成');

    // 历史完成里不能混进本周的
    const week = views.today.week;
    for (const todo of views.today.historyDone) {
      assert.ok(todo.completedDate < week.from, `历史完成里混进了本周的「${todo.title}」（${todo.completedDate}）`);
    }
  });

  check('宿主把「本周之前完成」算进 historyDone，本周之前的都算', () => {
    const view = views.today;
    assert.ok(Array.isArray(view.historyDone), 'historyDone 必须是数组');
    assert.equal(view.historyTotal, view.historyDone.length, '夹具里条数不多，应当全部带回来');
    assert.ok(view.historyTotal > 0, '夹具里应当有历史完成，否则这条用例是空转');
    // 按完成日倒序
    const dates = view.historyDone.map((item) => item.completedDate);
    assert.deepEqual(dates, dates.slice().sort().reverse(), `historyDone 应当按完成日倒序：${JSON.stringify(dates)}`);
  });

  check('超过 8 条时先折叠，点「展开全部」才铺开', () => {
    // 造 12 条历史完成
    const many = Array.from({ length: 12 }, (_, index) => ({
      id: `h${index}`,
      title: `历史事项 ${index}`,
      status: 'done',
      completedDate: `2026-09-${String(10 + index).padStart(2, '0')}`,
      projectName: '订单中台',
    }));
    const view = { ...views.today, historyDone: many, historyTotal: 12 };
    const api = fakeApi('today', view);
    react.presets({ WorkPage: { 2: 'today' } });
    const element = react.createElement(slots.main.component, { api });

    const collapsed = react.render(element).tree;
    assert.ok(textOf(collapsed).includes('历史事项 0'), '应当露出最早的几条');
    assert.ok(!textOf(collapsed).includes('历史事项 11'), '第 12 条默认不该出现');
    assert.ok(textOf(collapsed).includes('展开全部 12 条'), '应当给出展开入口');

    findNode(collapsed, (n) => n.type === 'button' && textOf(n).trim().startsWith('展开全部')).props.onClick();
    const expanded = react.render(element).tree;
    assert.ok(textOf(expanded).includes('历史事项 11'), '展开后应当全部铺开');
    assert.ok(textOf(expanded).includes('收起'), '展开后应当能收起');
  });

  check('没有历史完成时给出空态文案，不是一片空白', () => {
    const view = { ...views.today, historyDone: [], historyTotal: 0 };
    const api = fakeApi('today', view);
    react.presets({ WorkPage: { 2: 'today' } });
    const text = textOf(react.render(react.createElement(slots.main.component, { api })).tree);
    assert.ok(text.includes('历史完成'), '这一节仍然要在');
    assert.match(text, /还没有完成过|还没有更早的完成记录/, '缺少空态文案');
  });
}

group('3d. 待办行的排版约束（一行放下 + 边框可见）');
{
  /** 从渲染树里把 <style> 的内容取出来（含 dangerouslySetInnerHTML 写法）。 */
  const styleOf = (tree) => cssOf(tree);

  const css = styleOf(renderPage('today').tree) || '';

  check('待办行是横向一行，不是标题/元信息分两行的纵向布局', () => {
    const rule = (css.match(/^\.aw-row-main\{[^}]*\}/m) || [])[0];
    assert.ok(rule, '找不到 .aw-row-main 规则');
    assert.doesNotMatch(rule, /flex-direction:column/, `.aw-row-main 又变成纵向了：${rule}`);
    assert.match(rule, /display:flex/);
  });

  check('行与行之间有一条常显的细线（不是靠 hover 才看得出来）', () => {
    // 台账式列表：不再给每行套一个圆角盒子，改成相邻行之间一条持续的细线
    assert.match(css, /^\.aw-list>\.aw-row\+\.aw-row\{border-top:1px solid var\(--rule\)\}/m, '相邻行之间缺少细线');
    const rule = (css.match(/^\.aw-row\{[^}]*\}/m) || [])[0];
    assert.ok(rule, '找不到 .aw-row 规则');
    assert.doesNotMatch(rule, /background:var\(--aw-panel\)/, '行不该再各自成一个色块');
  });

  check('三套皮肤各自声明完整的一色一变量，正文里不出现字面量颜色', () => {
    for (const skin of ['lido', 'dusk', 'jade']) {
      assert.match(css, new RegExp(`\\.aw-page\\[data-skin="${skin}"\\]\\{`), `缺少皮肤 ${skin}`);
    }
    // --paper / --ink / --accent 等核心变量每套都要有
    for (const variable of ['--paper:', '--ink:', '--accent:', '--rule:', '--field-line:', '--glass:']) {
      const count = css.split(variable).length - 1;
      assert.ok(count >= 3, `${variable} 应当在三套皮肤里都声明，实际 ${count} 处`);
    }
    const body = css.slice(css.indexOf('.aw-page{'));
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(body.split('.aw-page[data-skin="dusk"]')[0]), '皮肤块外面不该有十六进制颜色');
  });

  check('行高 40px（紧凑台账行距）', () => {
    assert.match(css, /^\.aw-row\{[^}]*min-height:40px/m);
    assert.match(css, /^\.aw-row\{[^}]*padding:4px 8px/m);
  });

  check('选中的分段按钮 hover 时仍保持选中色', () => {
    // 分段开关被做大之后，hover 把选中态冲成浅底就等于看不出选中了
    assert.match(css, /\.aw-btn\.is-on:hover:not\(:disabled\)\{[^}]*background:var\(--accent-hi\)/);
  });

  check('标题吃满剩余宽度、元信息与操作靠右，右侧不留空白', () => {
    const title = (css.match(/^\.aw-row-title\{[^}]*\}/m) || [])[0];
    const meta = (css.match(/^\.aw-row-meta\{[^}]*\}/m) || [])[0];
    assert.match(title, /flex:1 1 auto/, `标题应吃满剩余宽度：${title}`);
    assert.match(css, /^\.aw-row-main>\.aw-row-meta\{justify-content:flex-end\}/m, '行内元信息应靠右');
  });
}

group('4b. 空按钮回归（任何 button 都必须有文案）');
{
  const tabs = ['today', 'projects', 'reports', 'stats'];

  check('四个分页里没有一个空按钮', () => {
    const problems = [];
    for (const tab of tabs) {
      const { tree } = renderPage(tab);
      const labels = collectButtons(tree);
      const empty = labels.filter((label) => label === '');
      if (empty.length > 0) problems.push(`${tab}: ${empty.length} 个空按钮（共 ${labels.length} 个）`);
    }
    assert.deepEqual(problems, [], problems.join('；'));
  });

  check('设置弹层里也没有空按钮', () => {
    const problems = [];
    const settings = renderPage('reports', { WorkPage: { 2: 'reports', 3: true } });
    const emptySettings = collectButtons(settings.tree).filter((label) => label === '');
    if (emptySettings.length > 0) problems.push(`设置弹层: ${emptySettings.length} 个`);
    assert.deepEqual(problems, [], problems.join('；'));
  });

  check('项目页顶部有「新增项目」按钮', () => {
    const { tree, text } = renderPage('projects');
    assert.ok(text.includes('新增项目'), '缺少「新增项目」文案');
    const labels = collectButtons(tree);
    assert.ok(labels.some((label) => label === '新增项目'), `按钮文案里没有「新增项目」：${JSON.stringify(labels)}`);
  });

}

group('5. 组件不会在渲染期偷偷发请求');
{
  check('渲染只触发 open/refreshBoot 这类只读副作用', () => {
    const { api } = renderPage('today');
    const writes = api.calls.filter((call) => call[0] === 'send');
    assert.equal(writes.length, 0, `渲染期发生了写操作：${JSON.stringify(writes)}`);
  });

  check('四个分页的渲染副作用都是只读的', () => {
    for (const tab of ['today', 'projects', 'reports', 'stats']) {
      const { api } = renderPage(tab);
      const writes = api.calls.filter((call) => call[0] === 'send');
      assert.equal(writes.length, 0, `${tab} 渲染期发生了写操作：${JSON.stringify(writes)}`);
    }
  });
}

/* ------------------------------------------------------------------ */

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;

console.log(`\n${'─'.repeat(64)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项断言（渲染实例 ${react.instanceCount()} 个）`);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const item of failures) {
    console.log(`\n  ✗ ${item.label}\n${item.error.stack}`);
  }
}
rmSync(ROOT, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
