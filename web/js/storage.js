// localStorage 收口：aqd:* 键名全部集中在此，读写统一走 safeGet / safeSet
// （localStorage 不可用（隐私模式等）时静默降级：读返回 null，写跳过——与原先散落的 try/catch 行为等价）

export const MODEL_RANK_OPEN_KEY = 'aqd:modelRankOpen';   // 今日模型排行展开态记忆（收起 = 只看 Top5）
export const PROJECT_OPEN_KEY = 'aqd:projectStatsOpen';   // 「另有 N 个项目」折叠条展开态
export const idleToolsKey = 'aqd:idleToolsExpanded';      // 未启用工具卡折叠区展开态
export const THEME_KEY = 'aqd:theme';                     // 日间 / 夜间主题
export const ONBOARD_KEY = 'aqd:onboardDismissed';        // 新用户引导「知道了」已读标记
// 模型 chips 展开态：按卡记忆
export const mmOpenKeyOf = k => 'aqd:mmOpen:' + k;
// 卡片拖拽顺序：按容器记忆
export const cardOrderKey = id => 'aqd:order:' + id;

// localStorage.getItem：不可用时返回 null（调用方拿 null 走默认分支，与原 catch 行为等价）
export function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
// localStorage.setItem：不可用时静默跳过（抛异常会中断调用方后续逻辑，如 pointerup 里的 drag = null 会卡死拖拽状态机）
export function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 忽略 */ }
}
