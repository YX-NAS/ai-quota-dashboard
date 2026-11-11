'use strict';
// 线性外推（纯函数）：月度预估 / 当日预估。前后端只认这一份口径。
//
// 为什么分母是「日历天」而不是「有数据的天数」（v1.8 修正）：
//   1. 有数据的天数会把「整月没开机的周末」从分母里剔掉，日均被抬高 → 月底预估虚高。
//      例：20 天里只有 10 天有记录、共 ¥200，按有数据天数算日均 ¥20 → 月估 ¥600；
//      按日历天算日均 ¥10 → 月估 ¥300，后者才是「照这个速度一个月花多少」。
//   2. 新装用户当月第一天只有半天数据，按 1 天算等于把半天当整天 → 预估被压低一半。
// 因此：分母 = 覆盖起点（当月首条数据日；上月及更早有数据则为月初）~ 今天已过天数，
// 当日按实际已过比例计入（12:00 算 0.5 天）。
//
// 覆盖起点而不是「月初」：月中才装看板的用户，前面没有数据的半个月不该稀释日均。
const BJ = 8 * 3600e3;
const DAY_MS = 86400e3;
// 不足 6 小时不做外推：凌晨刚过零点时 1 单就能外推出天文数字（¥30 → ¥14400/月），
// 宁可不显示，也不给一个会被当成 bug 的数字。
const MIN_ELAPSED_DAYS = 0.25;

const pad2 = n => String(n).padStart(2, '0');

// 北京时间日历分量：y / m(0-based) / day / frac(当日已过比例 0~1)
function bjParts(now = Date.now()) {
  const t = now + BJ;
  const d = new Date(t);
  const msOfDay = ((t % DAY_MS) + DAY_MS) % DAY_MS;
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    day: d.getUTCDate(),
    frac: msOfDay / DAY_MS,
  };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

const monthKeyOf = (y, m) => `${y}-${pad2(m + 1)}`;

// 当月覆盖起点（几号）：当月最早一条数据日；当月无数据但更早有 → 月初；完全没有数据 → 今天
function coverageStartDay(dailyKeys, y, m, todayDay) {
  const mon = monthKeyOf(y, m);
  const keys = dailyKeys || [];
  const inMonth = keys.find(k => k.startsWith(mon));
  if (inMonth) return Number(inMonth.slice(8, 10));
  if (keys.some(k => k < `${mon}-01`)) return 1;
  return todayDay;
}

// 月度外推：spendCny 为本月累计（等价成本口径），dailyKeys 为全量日键（升序字符串）
function monthForecast({ dailyKeys = [], spendCny = 0, now = Date.now(), minElapsedDays = MIN_ELAPSED_DAYS } = {}) {
  const p = bjParts(now);
  const dim = daysInMonth(p.y, p.m);
  const startDay = coverageStartDay(dailyKeys, p.y, p.m, p.day);
  const elapsedDays = (p.day - startDay) + p.frac;
  const base = { daysInMonth: dim, startDay, todayDay: p.day, elapsedDays: Math.round(elapsedDays * 1000) / 1000, spendCny };
  if (!(elapsedDays >= minElapsedDays)) {
    return Object.assign(base, { ok: false, reason: 'insufficient', projectedCny: null });
  }
  const projectedCny = spendCny / elapsedDays * dim;
  return Object.assign(base, { ok: true, projectedCny: Math.round(projectedCny * 100) / 100 });
}

// 当日外推：今日已花 / 当日已过比例。同样有 6 小时下限。
function dayForecast({ spendCny = 0, now = Date.now(), minElapsedDays = MIN_ELAPSED_DAYS } = {}) {
  const p = bjParts(now);
  const frac = p.frac;
  if (!(frac >= minElapsedDays)) return { ok: false, reason: 'insufficient', projectedCny: null, elapsedFrac: Math.round(frac * 1000) / 1000 };
  return {
    ok: true,
    projectedCny: Math.round(spendCny / frac * 100) / 100,
    elapsedFrac: Math.round(frac * 1000) / 1000,
    spendCny,
  };
}

module.exports = { monthForecast, dayForecast, bjParts, daysInMonth, coverageStartDay, MIN_ELAPSED_DAYS };