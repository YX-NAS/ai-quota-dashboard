// 共享可变状态：快照 snap（写入口只在 main.js 的 load()，各渲染模块经 ES module 活绑定只读最新值）
export let snap = null;
export function setSnap(v) { snap = v; }

// 按日取某工具的聚合桶（snap.agg.daily[day][toolKey]，无则 null）
export function toolDay(day, key) { return (snap.agg.daily[day] || {})[key] || null; }
