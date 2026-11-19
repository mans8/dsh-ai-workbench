/**
 * AI 工作台账 — 状态模型与惰性顺延引擎。
 *
 * 本文件是全部业务状态的唯一权威（single source of truth）：
 *   - 浏览器面板通过 /ai-workbench/api 读写；
 *   - Agent 通过 workbench_todo / workbench_report 读写；
 *   - 两者调用完全相同的领域函数，不重复实现规则。
 *
 * 数据落在 ~/ai-workbench/state.json（可用 AI_WORKBENCH_STATE_FILE 覆盖），原子写入。
 *
 * ── 惰性顺延（核心机制）──────────────────────────────────────────────
 * 不做定时任务、不依赖进程常驻。任何一次读或写之前先调 rolloverThrough()，
 * 把「上次处理到的那天」到今天之间的每一天依次补算：
 *   未完成 → plannedDate 前进一天、rolloverCount 加一（顺延不产生新记录）
 * 所以「昨天没做完今天接着做」在数据上永远是同一条待办。
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isWorkday } from './calendar.js';
import {
  clampInt,
  compareKey,
  dayOfMonth,
  isKey,
  monthKeyOf,
  normalizeKey,
  nowIso,
  shiftKey,
  uid,
  weekdayOf,
  yearKeyOf,
} from './util.js';

/** 状态版本：字段或语义变化时递增，normalizeState 负责补齐。 */
export const STATE_VERSION = 1;

/** 顺延策略。 */
export const ROLLOVER = {
  INHERIT: 'inherit',
  ALWAYS: 'always',
  BACKLOG: 'backlog',
  NEVER: 'never',
};

/** 待办状态。 */
export const TODO_STATUS = {
  OPEN: 'open',
  DONE: 'done',
  DROPPED: 'dropped',
};

/** 报表状态。 */
export const REPORT_STATUS = {
  DRAFT: 'draft',
  FINAL: 'final',
  ARCHIVED: 'archived',
};

/** 默认配置。口径：重复任务一律顺延。 */
export const DEFAULT_SETTINGS = {
  /** 未完成待办的默认顺延策略。 */
  rolloverPolicy: ROLLOVER.ALWAYS,
  /** 重复任务实例的默认顺延策略（本机选择：一律顺延）。 */
  recurringRollover: ROLLOVER.ALWAYS,
  /** 周报以周一为一周之始。 */
  weekStartsOn: 1,
  /** 手工覆盖的日期性质：{ '2027-01-01': 'holiday' | 'workday' }。 */
  holidayOverrides: {},
  /** 报表落款 / 附加说明，渲染时追加到文末。 */
  reportFooter: '',
  /** 本机的周报汇总文件（多个），「添加进周报文件」时追写到末尾。 */
  reportFiles: [],
  /** 追加时写在日期后面的署名（如「 - 团队」）。留空则不写。 */
  reportSignature: '',
  /** 自定义报表模板（含 {{title}}/{{completed}}/{{next}} 等占位符）；留空用内置模板。 */
  reportTemplate: '',
};

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const ROLLOVER_VALUES = new Set(Object.values(ROLLOVER));
const STATUS_VALUES = new Set(Object.values(TODO_STATUS));
const REPORT_STATUS_VALUES = new Set(Object.values(REPORT_STATUS));
const FREQUENCIES = new Set(['daily', 'workdays', 'weekdays', 'weekly', 'monthly']);

/* ------------------------------------------------------------------ *
 * 规范化（脏数据不致命）
 * ------------------------------------------------------------------ */

/** 规范化字符串。 */
function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/** 规范化可空字符串（空串归一为 null）。 */
function nullableStr(value) {
  const s = str(value).trim();
  return s === '' ? null : s;
}

/** 规范化可空 day key。 */
function nullableKey(value) {
  return typeof value === 'string' && isKey(value) ? value : null;
}

/** 规范化字符串数组。 */
function strArray(value, max = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim().slice(0, 40))
    .slice(0, max);
}

/** 规范化日期数组。 */
function keyArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback.slice();
  return value.filter((item) => isKey(item)).slice(0, 400);
}

/** 规范化数值数组（整数，夹紧到区间）。 */
function intArray(value, min, max, maxLen = 60) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const n = clampInt(item, min, max, NaN);
    if (Number.isFinite(n) && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b).slice(0, maxLen);
}

/** 规范化设置。 */
function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const overrides = {};
  if (src.holidayOverrides && typeof src.holidayOverrides === 'object') {
    for (const [key, value] of Object.entries(src.holidayOverrides)) {
      if (isKey(key) && (value === 'holiday' || value === 'workday')) overrides[key] = value;
    }
  }
  return {
    rolloverPolicy: ROLLOVER_VALUES.has(src.rolloverPolicy) ? src.rolloverPolicy : DEFAULT_SETTINGS.rolloverPolicy,
    recurringRollover: ROLLOVER_VALUES.has(src.recurringRollover) ? src.recurringRollover : DEFAULT_SETTINGS.recurringRollover,
    weekStartsOn: 1,
    holidayOverrides: overrides,
    reportFooter: str(src.reportFooter, '').slice(0, 500),
    reportTemplate: str(src.reportTemplate, '').slice(0, 8000),
    // 只留绝对路径的 .md / .txt —— 相对路径会随工作目录漂移，写错文件比写不进去更糟
    reportFiles: Array.isArray(src.reportFiles)
      ? src.reportFiles
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.startsWith('/') && /\.(md|txt)$/i.test(item))
          .slice(0, 20)
      : [],
    reportSignature: str(src.reportSignature, DEFAULT_SETTINGS.reportSignature).slice(0, 40),
  };
}

/** 规范化项目。 */
function normalizeProject(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const status = ['active', 'paused', 'archived'].includes(src.status) ? src.status : 'active';
  return {
    id: str(src.id) || uid('pj'),
    name: str(src.name, '未命名项目').slice(0, 60),
    code: str(src.code, '').slice(0, 20),
    emoji: str(src.emoji, '📁').slice(0, 8),
    color: str(src.color, '#3FA88F').slice(0, 20),
    status,
    owner: str(src.owner, '').slice(0, 40),
    startedAt: nullableKey(src.startedAt),
    endedAt: nullableKey(src.endedAt),
    description: str(src.description, '').slice(0, 500),
    createdAt: str(src.createdAt) || nowIso(),
    updatedAt: str(src.updatedAt) || nowIso(),
    archivedAt: src.archivedAt ? str(src.archivedAt) : null,
  };
}

/** 规范化重复规则。 */
function normalizeRepeat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const freq = FREQUENCIES.has(raw.freq) ? raw.freq : null;
  if (!freq) return null;
  const out = { freq };
  if (freq === 'weekly') out.weekdays = intArray(raw.weekdays, 0, 6, 7);
  if (freq === 'monthly') out.monthDays = intArray(raw.monthDays, 1, 31, 31);
  return out;
}

/** 规范化待办。 */
function normalizeTodo(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const kind = src.kind === 'recurring' ? 'recurring' : 'once';
  const isTemplate = src.isTemplate === true;
  const status = STATUS_VALUES.has(src.status) ? src.status : TODO_STATUS.OPEN;
  return {
    id: str(src.id) || uid('td'),
    title: str(src.title, '未命名待办').slice(0, 200),
    note: str(src.note, '').slice(0, 2000),
    projectId: nullableStr(src.projectId),
    priority: PRIORITIES.includes(src.priority) ? src.priority : 'P2',
    tags: strArray(src.tags),
    kind,
    isTemplate,
    repeat: kind === 'recurring' ? normalizeRepeat(src.repeat) : null,
    templateId: nullableStr(src.templateId),
    plannedDate: isTemplate ? null : nullableKey(src.plannedDate),
    firstPlannedDate: isTemplate ? null : nullableKey(src.firstPlannedDate) ?? nullableKey(src.plannedDate),
    dueDate: nullableKey(src.dueDate),
    // 完成百分比：只用于汇报口径（周报里的「（30%）」）。做完了永远是 100%，不看这个字段。
    progress: clampInt(src.progress, 0, 100, 0),
    rollover: ROLLOVER_VALUES.has(src.rollover) ? src.rollover : ROLLOVER.INHERIT,
    status,
    archived: src.archived === true,
    backlog: src.backlog === true,
    rolloverCount: clampInt(src.rolloverCount, 0, 9999, 0),
    createdAt: str(src.createdAt) || nowIso(),
    updatedAt: str(src.updatedAt) || nowIso(),
    completedAt: src.completedAt ? str(src.completedAt) : null,
    completedDate: nullableKey(src.completedDate),
    droppedAt: src.droppedAt ? str(src.droppedAt) : null,
    dropReason: nullableStr(src.dropReason),
    missedDate: nullableKey(src.missedDate),
    logId: nullableStr(src.logId),
  };
}

/** 规范化事实流水。 */
function normalizeLog(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    id: str(src.id) || uid('lg'),
    date: nullableKey(src.date) ?? normalizeKey(src.date),
    at: str(src.at) || nowIso(),
    title: str(src.title, '未命名记录').slice(0, 300),
    projectId: nullableStr(src.projectId),
    todoId: nullableStr(src.todoId),
    note: str(src.note, '').slice(0, 2000),
    source: ['todo', 'manual', 'import'].includes(src.source) ? src.source : 'manual',
    rolloverCount: clampInt(src.rolloverCount, 0, 9999, 0),
    voided: src.voided === true,
    voidedAt: src.voidedAt ? str(src.voidedAt) : null,
  };
}

/** 规范化报表。 */
function normalizeReport(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const type = ['weekly', 'monthly', 'yearly', 'project'].includes(src.type) ? src.type : 'weekly';
  return {
    id: str(src.id) || uid('rp'),
    type,
    dimension: type === 'project' ? 'project' : 'time',
    projectId: nullableStr(src.projectId),
    from: nullableKey(src.from) ?? normalizeKey(src.from),
    to: nullableKey(src.to) ?? normalizeKey(src.from),
    title: str(src.title, '未命名报表').slice(0, 200),
    status: REPORT_STATUS_VALUES.has(src.status) ? src.status : REPORT_STATUS.DRAFT,
    revision: clampInt(src.revision, 1, 999, 1),
    content: str(src.content, ''),
    facts: src.facts && typeof src.facts === 'object' ? src.facts : null,
    createdAt: str(src.createdAt) || nowIso(),
    updatedAt: str(src.updatedAt) || nowIso(),
    finalizedAt: src.finalizedAt ? str(src.finalizedAt) : null,
    archivedAt: src.archivedAt ? str(src.archivedAt) : null,
    supersedes: nullableStr(src.supersedes),
  };
}

/** 初始状态（空白，不带示例数据 —— 工作台账不该有假数据）。 */
export function defaultState() {
  return {
    version: STATE_VERSION,
    settings: { ...DEFAULT_SETTINGS, holidayOverrides: {} },
    cursor: { rolledThrough: null, lastSeenAt: null },
    projects: [],
    todos: [],
    logs: [],
    reports: [],
    rolloverLog: {},
    meta: { createdAt: nowIso(), updatedAt: nowIso(), seeded: false },
  };
}

/** 把任意输入规范化为合法状态。 */
export function normalizeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const state = defaultState();
  state.version = STATE_VERSION;
  state.settings = normalizeSettings(src.settings);
  state.cursor = {
    rolledThrough: nullableKey(src.cursor?.rolledThrough),
    lastSeenAt: src.cursor?.lastSeenAt ? str(src.cursor.lastSeenAt) : null,
  };
  state.projects = Array.isArray(src.projects) ? src.projects.map(normalizeProject) : [];
  state.todos = Array.isArray(src.todos) ? src.todos.map(normalizeTodo) : [];
  state.logs = Array.isArray(src.logs) ? src.logs.map(normalizeLog) : [];
  state.reports = Array.isArray(src.reports) ? src.reports.map(normalizeReport) : [];
  state.rolloverLog = {};
  if (src.rolloverLog && typeof src.rolloverLog === 'object') {
    for (const [key, value] of Object.entries(src.rolloverLog)) {
      if (isKey(key)) state.rolloverLog[key] = clampInt(value, 0, 9999, 0);
    }
  }
  state.meta = {
    createdAt: src.meta?.createdAt ? str(src.meta.createdAt) : nowIso(),
    updatedAt: src.meta?.updatedAt ? str(src.meta.updatedAt) : nowIso(),
    // 关键：必须保留 seeded，否则每次重启都会用 cordis.patch 的默认值
    // 覆盖用户在设置面板里改过的顺延策略。
    seeded: src.meta?.seeded === true,
  };
  return state;
}

/**
 * 版本迁移入口（当前只有 v1，故为占位实现）。
 *
 * 升级字段语义时在这里按 version 逐级转换，再交给 normalizeState 规范化。
 * 读到比本插件更新的版本时直接抛错，由 readState 备份原文件后启动空白状态，
 * 避免旧代码用 normalizeState 静默丢弃新版本字段。
 */
export function migrateState(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const version = Number.isInteger(raw.version) ? raw.version : 1;
  if (version > STATE_VERSION) {
    throw new Error(`状态文件版本 ${version} 高于插件支持的 ${STATE_VERSION}`);
  }
  // v1 → v1：无需转换；未来在此添加 while (version < STATE_VERSION) { ... }。
  return raw;
}

/* ------------------------------------------------------------------ *
 * 持久化
 * ------------------------------------------------------------------ */

/**
 * 状态文件路径：默认 `~/ai-workbench/state.json`。
 * 可用 `AI_WORKBENCH_STATE_FILE` 覆盖（测试 / 多实例场景）。
 */
export function stateFile() {
  return process.env.AI_WORKBENCH_STATE_FILE || join(homedir(), 'ai-workbench', 'state.json');
}

/** 旧版本路径（v1.0.0 之前），仅用于一次性迁移，不再作为写入目标。 */
function legacyStateFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  // 旧品牌时期的真实路径，仅为兼容老数据而保留，不是当前写入目标。
  return join(home, 'xuanwu-work', 'state.json');
}

/** 读取状态；新路径不存在时尝试从旧路径迁移；损坏时先备份原文件再启动空白状态。 */
export async function readState() {
  const file = stateFile();
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const legacy = legacyStateFile();
      if (legacy !== file) {
        try {
          const oldText = await readFile(legacy, 'utf8');
          const migrated = normalizeState(migrateState(JSON.parse(oldText)));
          await mkdir(dirname(file), { recursive: true });
          await copyFile(legacy, file);
          console.warn(`[ai-workbench] 已从旧位置迁移状态：${legacy} → ${file}`);
          return migrated;
        } catch (migrationError) {
          if (migrationError?.code !== 'ENOENT') {
            console.warn(`[ai-workbench] 旧位置状态迁移失败（${migrationError?.message ?? migrationError}），将以空白状态启动`);
          }
        }
      }
      const fresh = defaultState();
      await writeState(fresh);
      return fresh;
    }
    throw error; // 读不了（权限等）就大声失败，不静默覆盖
  }

  try {
    return normalizeState(migrateState(JSON.parse(text)));
  } catch (error) {
    const backup = `${file}.corrupt-${Date.now()}.bak`;
    try {
      await copyFile(file, backup);
      console.warn(`[ai-workbench] 状态文件损坏（${error?.message ?? error}），已备份到 ${backup}，将以空白状态启动`);
    } catch (copyError) {
      console.warn(`[ai-workbench] 状态文件损坏且备份失败（${copyError?.message ?? copyError}），将以空白状态启动：${file}`);
    }
    const fresh = defaultState();
    await writeState(fresh);
    return fresh;
  }
}

/** 原子写入：先写临时文件再 rename。 */
export async function writeState(state) {
  const file = stateFile();
  state.meta = { ...(state.meta ?? {}), updatedAt: nowIso() };
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

/* ------------------------------------------------------------------ *
 * 查询辅助
 * ------------------------------------------------------------------ */

/** 按项目 id 取项目。 */
export function projectById(state, id) {
  if (!id) return null;
  return state.projects.find((item) => item.id === id) ?? null;
}

/** 按 id 取待办。 */
export function todoById(state, id) {
  if (!id) return null;
  return state.todos.find((item) => item.id === id) ?? null;
}

/** 按 id 取报表。 */
export function reportById(state, id) {
  if (!id) return null;
  return state.reports.find((item) => item.id === id) ?? null;
}

/** 未作废的事实流水（按日期升序）。 */
export function activeLogs(state) {
  return state.logs.filter((item) => !item.voided);
}

/* ------------------------------------------------------------------ *
 * 顺延引擎
 * ------------------------------------------------------------------ */

/**
 * 解析一条待办实际生效的顺延策略。
 * 显式指定优先；否则普通待办用 rolloverPolicy，重复任务实例用 recurringRollover。
 */
export function resolveRollover(todo, settings) {
  if (todo.rollover && todo.rollover !== ROLLOVER.INHERIT && ROLLOVER_VALUES.has(todo.rollover)) {
    return todo.rollover;
  }
  const isRecurring = todo.kind === 'recurring' || todo.templateId != null;
  return isRecurring ? settings.recurringRollover : settings.rolloverPolicy;
}

/** 重复规则是否命中某一天。 */
export function recurrenceMatches(repeat, key, overrides) {
  if (!repeat) return false;
  switch (repeat.freq) {
    case 'daily':
      return true;
    case 'workdays':
      return isWorkday(key, overrides);
    case 'weekdays': {
      const w = weekdayOf(key);
      return w >= 1 && w <= 5;
    }
    case 'weekly':
      return Array.isArray(repeat.weekdays) && repeat.weekdays.includes(weekdayOf(key));
    case 'monthly':
      return Array.isArray(repeat.monthDays) && repeat.monthDays.includes(dayOfMonth(key));
    default:
      return false;
  }
}

/** 该重复模板是否处于启用状态。 */
export function templateActive(template) {
  return template.kind === 'recurring' && template.isTemplate === true && template.status === TODO_STATUS.OPEN && !template.archived && !!template.repeat;
}

/**
 * 为某一天物化重复任务实例。
 *
 * 「一次只留一个未完成实例」是这里的关键：若该模板已有未完成实例（会被顺延），
 * 就不再新开一条，否则一周没打开面板会堆出 5 条一模一样的「站会」。
 * 这既贯彻了「未完成一律顺延」，又不会重复堆积。
 */
export function materializeRecurring(state, key, events) {
  const overrides = state.settings.holidayOverrides;  for (const template of state.todos) {
    if (!templateActive(template)) continue;
    if (!recurrenceMatches(template.repeat, key, overrides)) continue;
    const openExists = state.todos.some(
      (item) => item.templateId === template.id && item.status === TODO_STATUS.OPEN,
    );
    if (openExists) continue;
    const sameDay = state.todos.some((item) => item.templateId === template.id && item.plannedDate === key);
    if (sameDay) continue;
    const stamp = nowIso();
    const instance = {
      id: uid('td'),
      title: template.title,
      note: template.note,
      projectId: template.projectId,
      priority: template.priority,
      tags: template.tags.slice(),
      kind: 'recurring',
      isTemplate: false,
      repeat: null,
      templateId: template.id,
      plannedDate: key,
      firstPlannedDate: key,
      dueDate: key,
        rollover: ROLLOVER.ALWAYS,
      status: TODO_STATUS.OPEN,
      archived: false,
      backlog: false,
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
    state.todos.push(instance);
    events.created.push({ id: instance.id, title: instance.title, date: key });
  }
}

/**
 * 把顺延游标从 cursor.rolledThrough 推进到 today。
 *
 * @param state 状态（就地修改）
 * @param today 目标 day key
 * @returns {{ days: number, moved: Array, missed: Array, created: Array }}
 */
export function rolloverThrough(state, today) {
  const events = { days: 0, moved: [], missed: [], created: [] };
  const target = normalizeKey(today);
  const stored = state.cursor.rolledThrough;

  // 首次运行：不回溯历史，只把游标对齐到今天并补上今天的重复实例。
  if (!stored) {
    state.cursor.rolledThrough = target;
    materializeRecurring(state, target, events);
    return events;
  }

  let cursor = normalizeKey(stored, target);
  // 系统时钟被调早：既不撤销已经发生的顺延，也不回退游标。
  // 回退游标会让同一段日子被重复记账，宁可让补算停摆到时钟追上为止。
  if (compareKey(cursor, target) > 0) return events;

  while (compareKey(cursor, target) < 0) {
    const next = shiftKey(cursor, 1);
    let movedFromCursor = 0;

    for (const todo of state.todos) {
      if (todo.status !== TODO_STATUS.OPEN) continue;
      if (todo.archived) continue;
      if (todo.isTemplate) continue; // 模板不参与顺延，由实例承接
      if (!todo.plannedDate) continue;
      if (compareKey(todo.plannedDate, cursor) > 0) continue; // 还没到期

      const policy = resolveRollover(todo, state.settings);
      if (policy === ROLLOVER.NEVER) {
        todo.status = TODO_STATUS.DROPPED;
        todo.dropReason = 'missed';
        todo.missedDate = cursor;
        todo.droppedAt = nowIso();
        todo.updatedAt = nowIso();
        events.missed.push({ id: todo.id, title: todo.title, date: cursor });
        continue;
      }

      if (todo.plannedDate === cursor) movedFromCursor += 1;
      if (policy === ROLLOVER.BACKLOG) todo.backlog = true;
      todo.plannedDate = next;
      todo.rolloverCount += 1;
      todo.backlog = policy === ROLLOVER.BACKLOG ? true : todo.backlog;
      todo.updatedAt = nowIso();
      events.moved.push({ id: todo.id, title: todo.title, from: cursor, to: next });
    }

    if (movedFromCursor > 0) {
      state.rolloverLog[cursor] = (state.rolloverLog[cursor] ?? 0) + movedFromCursor;
    }
    materializeRecurring(state, next, events);
    cursor = next;
    events.days += 1;
  }

  state.cursor.rolledThrough = target;
  return events;
}

/* ------------------------------------------------------------------ *
 * 报表辅助（供 reports.js 与 actions.js 共用）
 * ------------------------------------------------------------------ */

/** 报表区间内的有效事实流水。 */
export function logsInRange(state, from, to, projectId) {
  // 按项目过滤时以**待办当前所属项目**为准：事后把一件事挪到别的项目，
  // 它就应该算在新区目里，而不是留在流水写死的老项目。
  const liveProjects = projectId ? new Map(state.todos.map((todo) => [todo.id, todo.projectId])) : null;
  return activeLogs(state).filter((log) => {
    if (compareKey(log.date, from) < 0 || compareKey(log.date, to) > 0) return false;
    if (projectId) {
      const live = log.todoId ? liveProjects.get(log.todoId) : undefined;
      const pid = live === undefined ? log.projectId : live;
      if (pid !== projectId) return false;
    }
    return true;
  });
}

/** 区间键（月/年）——给统计聚合分组用。 */
export function bucketKeyOf(key, dim) {
  if (dim === 'year') return yearKeyOf(key);
  if (dim === 'month') return monthKeyOf(key);
  return key;
}
