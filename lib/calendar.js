/**
 * AI 工作台账 — 中国法定工作日日历。
 *
 * 数据来自 `data/china-holidays.json`（vendored，来源 chinese-days，MIT）：
 *   holidays[dayKey] = 节日名  → 法定放假（不计工作日）
 *   workdays[dayKey] = 节日名  → 调休上班的周末（计工作日）
 *
 * 法定工作日 = 周一~周五 且 不在 holidays，加上 workdays 里的调休上班日。
 *
 * 三条设计原则：
 *   1. 数据缺失的年份**绝不静默估算**，可通过 isCovered() 暴露出来由上层展示警告；
 *   2. 用户可用 settings.holidayOverrides 覆盖任意一天（公司额外放假 / 特殊作息）；
 *   3. 日历资产只读，不进 state.json。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareKey, eachDay, isKey, monthRange, weekdayOf, yearKeyOf } from './util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(HERE, '..', 'data', 'china-holidays.json');

/** 日期性质。 */
export const DAY_KIND = {
  WORKDAY: 'workday',
  ADJUSTED: 'adjusted-workday',
  HOLIDAY: 'holiday',
  WEEKEND: 'weekend',
};

/** 日历数据的加载状态（错误只在首次加载时报告一次）。 */
let cache = null;

/** 懒加载日历资产；失败时退化为空表并记录错误。 */
function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    const holidays = raw.holidays && typeof raw.holidays === 'object' ? raw.holidays : {};
    const workdays = raw.workdays && typeof raw.workdays === 'object' ? raw.workdays : {};
    const years = new Set();
    for (const key of Object.keys(holidays)) years.add(yearKeyOf(key));
    for (const key of Object.keys(workdays)) years.add(yearKeyOf(key));
    cache = {
      holidays,
      workdays,
      range: Array.isArray(raw.range) ? raw.range : [keysMin(holidays), keysMax(holidays)],
      years,
      error: null,
    };
  } catch (error) {
    console.warn(`[ai-workbench] 日历数据读取失败，将退化为「周一~周五 = 工作日」：${error?.message ?? error}`);
    cache = { holidays: {}, workdays: {}, range: ['', ''], years: new Set(), error: String(error?.message ?? error) };
  }
  return cache;
}

/** 最早的 key。 */
function keysMin(obj) {
  const keys = Object.keys(obj).sort();
  return keys[0] ?? '';
}

/** 最晚的 key。 */
function keysMax(obj) {
  const keys = Object.keys(obj).sort();
  return keys[keys.length - 1] ?? '';
}

/** 日历资产的元信息，给面板展示与告警用。 */
export function holidayInfo() {
  const data = load();
  const years = Array.from(data.years).sort();
  return {
    from: data.range?.[0] ?? '',
    to: data.range?.[1] ?? '',
    years,
    minYear: years.length > 0 ? Number(years[0]) : null,
    maxYear: years.length > 0 ? Number(years[years.length - 1]) : null,
    holidayCount: Object.keys(data.holidays).length,
    workdayCount: Object.keys(data.workdays).length,
    error: data.error,
  };
}

/** 该日期是否落在日历数据已覆盖的年份内。 */
export function isCovered(key) {
  if (!isKey(key)) return false;
  return load().years.has(yearKeyOf(key));
}

/** 用户手工覆盖项。 */
function overrideOf(overrides, key) {
  if (!overrides || typeof overrides !== 'object') return null;
  const value = overrides[key];
  return value === 'holiday' || value === 'workday' ? value : null;
}

/** 该日期的性质。 */
export function dayKind(key, overrides) {
  const forced = overrideOf(overrides, key);
  if (forced === 'holiday') return DAY_KIND.HOLIDAY;
  if (forced === 'workday') return DAY_KIND.ADJUSTED;
  const data = load();
  if (Object.prototype.hasOwnProperty.call(data.holidays, key)) return DAY_KIND.HOLIDAY;
  if (Object.prototype.hasOwnProperty.call(data.workdays, key)) return DAY_KIND.ADJUSTED;
  const w = weekdayOf(key);
  return w === 0 || w === 6 ? DAY_KIND.WEEKEND : DAY_KIND.WORKDAY;
}

/** 该日期是否计为法定工作日。 */
export function isWorkday(key, overrides) {
  const kind = dayKind(key, overrides);
  return kind === DAY_KIND.WORKDAY || kind === DAY_KIND.ADJUSTED;
}

/** 该日期的节日名（没有则空串）。 */
export function holidayNameOf(key, overrides) {
  const forced = overrideOf(overrides, key);
  const data = load();
  const name = data.holidays[key] || data.workdays[key] || '';
  if (forced === 'holiday') return name ? `${name}（手工标记放假）` : '手工标记放假';
  if (forced === 'workday') return name ? `${name}（手工标记上班）` : '手工标记上班';
  return name;
}

/** 统计 [from, to] 内的法定工作日天数。 */
export function workdaysInRange(from, to, overrides) {
  if (compareKey(from, to) > 0) return 0;
  let count = 0;
  for (const key of eachDay(from, to)) {
    if (isWorkday(key, overrides)) count += 1;
  }
  return count;
}

/** 统计某月（YYYY-MM）的法定工作日天数。 */
export function workdaysInMonth(ym, overrides) {
  const range = monthRange(ym);
  if (!range) return 0;
  return workdaysInRange(range.from, range.to, overrides);
}

