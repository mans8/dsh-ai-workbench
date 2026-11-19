/**
 * 往复现服务器里灌一份有代表性的工作台账。
 * 用法：先 `node server.mjs --reset`，再 `node seed.mjs`
 */
const API = `http://127.0.0.1:${process.env.AW_PORT ?? 8791}/ai-workbench/api`;

/** 发一个写操作并断言业务成功。 */
async function post(body) {
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok || data.result.ok !== true) {
    throw new Error(`${body.action} 失败：${data.result?.error ?? JSON.stringify(data).slice(0, 200)}`);
  }
  return data.result;
}

// 先在 10-11 建账，再拨到 10-12 —— 这样顺延、逾期、积压都是真实算出来的
const EARLY = '2026-10-11';
const TODAY = '2026-10-12';

await post({ action: 'project_create', name: '订单中台', code: 'OMS', emoji: '📦', owner: '我', today: EARLY });
await post({ action: 'project_create', name: '对账系统', code: 'REC', emoji: '🧾', today: EARLY });
await post({ action: 'todo_create', title: '订单导出接口重构', project: '订单中台', plannedDate: '2026-10-05', priority: 'P1', tags: ['重构'], today: EARLY });
await post({ action: 'todo_create', title: '支付回调幂等性改造', project: '订单中台', plannedDate: '2026-10-06', priority: 'P0', today: EARLY });
await post({ action: 'todo_create', title: '对账系统灰度方案设计', project: '对账系统', plannedDate: '2026-10-07', dueDate: '2026-10-09', progress: 30, today: EARLY });
await post({ action: 'todo_create', title: '整理接口文档', plannedDate: TODAY, progress: 40, today: EARLY });
await post({ action: 'todo_create', title: '背单词', plannedDate: '2026-10-10', rollover: 'backlog', today: EARLY });
await post({ action: 'todo_create', title: '与产品对齐导出字段', plannedDate: TODAY, today: EARLY });

// 完成待办：这里只写流水
await post({ action: 'todo_complete', task: '订单导出接口重构', date: '2026-10-05', note: 'QPS 从 120 提到 900', today: EARLY });
await post({ action: 'todo_complete', task: '支付回调幂等性改造', date: '2026-10-06', today: EARLY });
await post({ action: 'log_note', title: '梳理导出字段口径', date: '2026-10-07', project: '订单中台', today: EARLY });
// 今天完成一件，让「本周完成」有内容
await post({ action: 'todo_complete', task: '与产品对齐导出字段', date: TODAY, today: TODAY });

// ── 拨到今天 ──
await post({ action: 'todo_create', title: '每日站会', repeat: { freq: 'workdays' }, today: TODAY });
await post({ action: 'todo_create', title: '周一复盘', repeat: { freq: 'weekly', weekdays: [1] }, today: TODAY });

await post({ action: 'report_create', type: 'weekly', date: '2026-10-09', today: TODAY });
await post({ action: 'report_create', type: 'monthly', date: '2026-10-05', today: TODAY });

const view = await (await fetch(`${API}?view=today&today=${TODAY}`)).json();
console.log(
  `已灌入示例数据：今日待办 ${view.view.todos.length} 项 · 积压 ${view.view.backlog.length} 项 · 顺延 ${view.view.stats.carriedCount} 项 · 逾期 ${view.view.stats.overdueCount} 项`,
);
console.log(`本周完成 ${view.view.weekDone.length} 项（${view.view.week.from} ~ ${view.view.week.to}）`);
