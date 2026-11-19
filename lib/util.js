/**
 * AI 工作台账 — 通用工具：日期、数值、文本。
 *
 * 日期一律用「本地时区的 YYYY-MM-DD 字符串」（下称 day key）表示，
 * 所有解析都落在当天 12:00，避开夏令时边界（中国大陆无夏令时，这是防御性处理）。
 */

/** 一天的毫秒数。 */
const DAY_MS = 86400000;
/** 周名称（0 = 周日）。 */
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
/** eachDay 的硬上限，防止脏数据把循环撑爆。 */
const MAX_SPAN_DAYS = 4000;

let uidSeed = 0;

/** 生成稳定前缀的短 id。 */
export function uid(prefix) {
  uidSeed += 1;
  return `${prefix}_${Date.now().toString(36)}${uidSeed.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 现在是 ISO 时间戳（记事件用，不参与业务日期判断）。 */
export function nowIso() {
  return new Date().toISOString();
}

/** 取整数并夹紧到区间内。null / undefined / 空串一律走 fallback。 */
export function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 取浮点并夹紧到区间内。null / undefined / 空串一律走 fallback。 */
export function clampNum(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 保留两位小数（消除浮点噪声，例如 0.1 + 0.2）。 */
export function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** 百分比，保留一位小数；分母为 0 时返回 0。 */
export function pct(part, whole) {
  const w = Number(whole) || 0;
  if (w <= 0) return 0;
  return Math.round(((Number(part) || 0) / w) * 1000) / 10;
}

/** 补零到两位。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区的 YYYY-MM-DD。 */
export function dayKeyOf(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 解析 day key 为本地中午的 Date（无效时返回 Invalid Date）。 */
export function parseKey(key) {
  const parts = String(key ?? '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return new Date(NaN);
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
}

/** 是否是合法的 day key 字符串。 */
export function isKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const dt = parseKey(value.trim());
  return !Number.isNaN(dt.getTime()) && dayKeyOf(dt) === value.trim();
}

/** 宽松校验后归一化；非法则返回 fallback。 */
export function normalizeKey(key, fallback = dayKeyOf()) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key.trim())) return fallback;
  const dt = parseKey(key.trim());
  return Number.isNaN(dt.getTime()) ? fallback : dayKeyOf(dt);
}

/** day key 平移 n 天。 */
export function shiftKey(key, days) {
  const dt = parseKey(key);
  if (Number.isNaN(dt.getTime())) return key;
  dt.setDate(dt.getDate() + Number(days || 0));
  return dayKeyOf(dt);
}

/** 该日期是星期几（0 = 周日）。 */
export function weekdayOf(key) {
  const dt = parseKey(key);
  return Number.isNaN(dt.getTime()) ? 0 : dt.getDay();
}

/** 星期几的中文单字。 */
export function weekdayLabel(key) {
  return WEEKDAY_NAMES[weekdayOf(key)];
}

/** 该日期是否周末（仅按星期判断，不考虑调休）。 */
export function isWeekend(key) {
  const w = weekdayOf(key);
  return w === 0 || w === 6;
}

/** YYYY-MM。 */
export function monthKeyOf(key) {
  return String(key ?? '').slice(0, 7);
}

/** YYYY。 */
export function yearKeyOf(key) {
  return String(key ?? '').slice(0, 4);
}

/** 月内的日号（1~31）。 */
export function dayOfMonth(key) {
  return Number(String(key ?? '').slice(8, 10)) || 1;
}

/** 某年某月有多少天（month 为 1~12）。 */
export function daysInMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

/** 某月的起止 day key。 */
export function monthRange(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(daysInMonth(y, m))}` };
}

/** 某年的起止 day key。 */
export function yearRange(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return null;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/** 月份加减，返回 YYYY-MM。 */
export function addMonths(ym, delta) {
  const [y, m] = String(ym).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const total = y * 12 + (m - 1) + Number(delta || 0);
  return `${Math.floor(total / 12)}-${pad2((total % 12 + 12) % 12 + 1)}`;
}

/** a、b 的字典序比较（day key 可直接比较）。 */
export function compareKey(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** key 是否落在 [from, to] 内（闭区间）。 */
export function isKeyInRange(key, from, to) {
  return compareKey(key, from) >= 0 && compareKey(key, to) <= 0;
}

/**
 * 枚举 [from, to] 的每一天。
 * 区间非法或超过上限时返回空数组/截断，绝不无限循环。
 */
/**
 * key 当天或之前最近的某个星期几（0=周日 … 4=周四 … 6=周六）。
 * 今天正好是那天就返回今天。
 */
export function recentWeekdayKey(key, weekday) {
  const dt = parseKey(key);
  const safe = Number.isNaN(dt.getTime()) ? new Date() : dt;
  const back = (safe.getDay() - weekday + 7) % 7;
  const out = new Date(safe.getTime());
  out.setDate(out.getDate() - back);
  return dayKeyOf(out);
}

/** 区间包含的天数（含首尾）。 */
export function daySpan(from, to) {
  if (!isKey(from) || !isKey(to)) return 1;
  const diff = (parseKey(to).getTime() - parseKey(from).getTime()) / 86400000;
  return Math.max(1, Math.round(diff) + 1);
}

export function eachDay(from, to) {
  const out = [];
  if (!isKey(from) || !isKey(to) || compareKey(from, to) > 0) return out;
  let cursor = from;
  let guard = 0;
  while (compareKey(cursor, to) <= 0 && guard < MAX_SPAN_DAYS) {
    out.push(cursor);
    cursor = shiftKey(cursor, 1);
    guard += 1;
  }
  return out;
}

/**
 * ISO 周信息（周一为一周之始，含跨年周）。
 * @returns {{ year: number, week: number }}
 */
export function isoWeekInfo(key) {
  const dt = parseKey(key);
  if (Number.isNaN(dt.getTime())) return { year: Number(yearKeyOf(key)) || 1970, week: 1 };
  const target = new Date(dt.getTime());
  const dayNum = (target.getDay() + 6) % 7; // 周一 = 0
  target.setDate(target.getDate() - dayNum + 3); // 移到本周四
  const isoYear = target.getFullYear();
  const firstThursday = new Date(isoYear, 0, 4, 12, 0, 0, 0);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return { year: isoYear, week };
}

/** key 所在 ISO 周（周一 ~ 周日）的起止。 */
/**
 * 以 key 所在的「自然周」为区间。
 * @param weekStartsOn 周起始日，1=周一（默认，ISO），5=周五（周报口径）
 */
export function weekRange(key, weekStartsOn = 1) {
  const dt = parseKey(key);
  const safe = Number.isNaN(dt.getTime()) ? new Date() : dt;
  // 0=周一 … 6=周日
  const dow = (safe.getDay() + 6) % 7;
  const startDow = (weekStartsOn + 6) % 7;
  const start = new Date(safe.getTime());
  start.setDate(start.getDate() - ((dow - startDow + 7) % 7));
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 6);
  const info = isoWeekInfo(dayKeyOf(start));
  return { from: dayKeyOf(start), to: dayKeyOf(end), week: info.week, year: info.year };
}

/** 月份的中文标签，如「2026 年 10 月」。 */
export function monthLabel(ym) {
  const [y, m] = String(ym).split('-');
  return `${y} 年 ${Number(m)} 月`;
}

/** 人类可读的日期，如「10-12 周一」。 */
export function shortLabel(key) {
  return `${String(key).slice(5)} 周${weekdayLabel(key)}`;
}

/** 小时数格式化：7.5 → "7.5h"，7 → "7h"。 */
export function fmtHours(value) {
  const n = round2(value);
  if (Number.isInteger(n)) return `${n}h`;
  return `${n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}h`;
}

/** 截断文本。 */
export function truncate(text, max = 120) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
