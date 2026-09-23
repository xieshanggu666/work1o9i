// ===== 统一区间分摊口径 =====
// 跨「小时 / 自然日 / 周 / 月」边界的运行段，不能按结束时间整段归属，
// 必须按 功率 × 重叠时长（kWh）拆分到它实际覆盖的每个区间。
// 三处记账共用本模块，保证口径一致、互不打架：
//   1) 分段结算：结段 / 重启补结时跨本地整点自动拆行（日、周、月边界均为整点，一并覆盖）
//   2) 小时趋势：24h 聚合按与窗口、与小时桶的重叠时长分摊（兼容历史未拆的旧记录）
//   3) 定额统计：周期用量按与周期窗口的重叠时长分摊，跨周期运行段不再被整段计入新周期
//
// 所有时间均按服务器本地时间解释，与 energy / quota 模块既有口径一致。

export const HOUR_MS = 3600_000

export const round4 = (v) => Math.round(v * 10000) / 10000

// 本地时区整点
export function hourFloor(ms) {
  const d = new Date(ms)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

// 本地时区自然日零点
export function dayFloor(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// 自然日键（本地零点 ISO）：按日留存累计用量的稳定身份，跨设备/房间通用
export function dayKey(ms) {
  return new Date(dayFloor(ms)).toISOString()
}

// 把 [startMs,endMs) 按本地整点切成若干分片，附该片占原区间的时长比例
export function splitByHour(startMs, endMs) {
  const parts = []
  const total = endMs - startMs
  let s = startMs
  let boundary = hourFloor(s) + HOUR_MS
  while (s < endMs) {
    const e = Math.min(endMs, boundary)
    parts.push({ start: s, end: e, frac: total > 0 ? (e - s) / total : 0 })
    s = e
    boundary += HOUR_MS
  }
  return parts
}

// 恒定功率段在窗口 [wStartMs,wEndMs) 内的 kWh（瓦 × 毫秒 → kWh）
export function wattsInWindow(watts, startMs, endMs, wStartMs, wEndMs) {
  const s = Math.max(startMs, wStartMs)
  const e = Math.min(endMs, wEndMs)
  return e > s ? (watts * (e - s)) / 3_600_000_000 : 0
}

// 已落库记录（含 watts=0 的旧版迁移行）按重叠时长比例，把已有 kwh 分摊进窗口。
// 新记录的 kwh 本身 = 功率×时长，比例分摊与按功率重算完全等价；
// 旧记录只有总量没有可信功率，只能也只需按时间比例分摊。
export function kwhInWindow(kwh, startMs, endMs, wStartMs, wEndMs) {
  if (endMs <= startMs) return 0
  const s = Math.max(startMs, wStartMs)
  const e = Math.min(endMs, wEndMs)
  return e > s ? (kwh * (e - s)) / (endMs - startMs) : 0
}

// 遍历与窗口 [wStartMs,wEndMs) 实际相交的每个整点分片：
// fn(分片内窗口起点 s, 分片内窗口终点 e, 整点分片 p)
export function forEachHourSlice(startMs, endMs, wStartMs, wEndMs, fn) {
  for (const p of splitByHour(startMs, endMs)) {
    const s = Math.max(p.start, wStartMs)
    const e = Math.min(p.end, wEndMs)
    if (e > s) fn(s, e, p)
  }
}
