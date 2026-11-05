'use strict';
// 北京时间日期工具（单一事实源）：store / alerts / push / report 统一从这里取用。
// 口径与历史实现逐位一致：UTC+8 平移后取 ISO 日期串。
// 注意：改动本文件语义会同时影响「聚合切日 / 冷却 key / 报表周期」三处，务必整体评估。
const bjDate = ts => {
  // 北京时间日期串 YYYY-MM-DD
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};
const bjMonth = ts => bjDate(ts).slice(0, 7);

module.exports = { bjDate, bjMonth };
