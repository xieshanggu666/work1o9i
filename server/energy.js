// ===== 分段累计用电 =====
// 设备每一段「开启 + 功率稳定」的运行区间：段首写入 energy_segments；
// 开关切换 / 功率编辑 / 改名 / 换房时，先把旧段按 功率(kW)×时长(h) 结落入
// energy_records，再按当前状态开新段。
// 记录以 device_id 为稳定标识（不设级联外键——删除设备后历史保留），
// 同时冗余产生该段用电时的设备名 / 房间名快照与完整 ISO 起止时间：
// 改名、换房只影响之后的段，历史始终归属产生它的名字与房间。

import { round4, HOUR_MS, splitByHour, kwhInWindow, forEachHourSlice } from './prorate.js'

const SEG_TICK_MS = 30_000          // 模拟设备运行：每 30s 结段并续开，用电持续落库
const KEEP_MS = 7 * 24 * 3600_000   // 分段明细保留 7 天
const MAX_RECOVER_MS = 3600_000     // 服务重启后，上次未结段最多向前补结 1h，避免停机数日补出巨额用电

// db 由入口在 db.js 完成建表/播种后传入，规避「energy 顶层 import db → db 尚未 seed」的循环时序问题
let db
let stmts

export function initEnergy(database) {
  db = database
  db.exec(`
  CREATE TABLE IF NOT EXISTS energy_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER,             -- 稳定标识；删除设备不级联，历史记录保留
    device_name TEXT NOT NULL,     -- 该段用电产生时的名称快照
    room TEXT NOT NULL,            -- 该段用电产生时的房间快照
    watts INTEGER NOT NULL DEFAULT 0,
    kwh REAL NOT NULL,
    start_time TEXT NOT NULL,      -- 段开始，完整 ISO 时间
    end_time TEXT NOT NULL,        -- 段结束，完整 ISO 时间
    hour INTEGER NOT NULL          -- 该分片起点所在本地小时（0-23）；跨整点段结段时拆成多行，每行只落一个小时桶
  );
  CREATE INDEX IF NOT EXISTS idx_energy_records_end ON energy_records(end_time);
  CREATE INDEX IF NOT EXISTS idx_energy_records_start ON energy_records(start_time);
  CREATE INDEX IF NOT EXISTS idx_energy_records_device ON energy_records(device_id);
  CREATE TABLE IF NOT EXISTS energy_segments (
    device_id INTEGER PRIMARY KEY,
    device_name TEXT NOT NULL,
    room TEXT NOT NULL,
    watts INTEGER NOT NULL,
    start_time TEXT NOT NULL
  );
  `)
  stmts = {
    deviceById: db.prepare(
      `SELECT d.*, r.name room FROM devices d JOIN rooms r ON r.id=d.room_id WHERE d.id=?`),
    getSeg: db.prepare('SELECT * FROM energy_segments WHERE device_id=?'),
    allSegs: db.prepare('SELECT * FROM energy_segments'),
    delSeg: db.prepare('DELETE FROM energy_segments WHERE device_id=?'),
    clearSegs: db.prepare('DELETE FROM energy_segments'),
    upsertSeg: db.prepare(`INSERT OR REPLACE INTO energy_segments
      (device_id,device_name,room,watts,start_time) VALUES (?,?,?,?,?)`),
    insertRec: db.prepare(`INSERT INTO energy_records
      (device_id,device_name,room,watts,kwh,start_time,end_time,hour) VALUES (?,?,?,?,?,?,?,?)`)
  }

  // 初始化顺序：迁移旧数据 → 重启恢复（补结上次未结段、清空段表）
  // → 首次播种 → 按设备当前状态重建运行段。
  // 必须先恢复后播种：段首是本次启动时刻，若先播种再恢复，补结会把旧段
  // （含服务停机区间）以当前快照错误地算到播种窗口里。
  migrateLegacyEnergy()
  recoverOnStartup()
  seedEnergy()
  for (const d of runningDevices()) openSeg(d, new Date())

  setInterval(tick, SEG_TICK_MS)
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try { flushAll() } catch { /* 退出优先 */ }
      process.exit(0)
    })
  }
}

const runningDevices = () => db.prepare(
  `SELECT d.*, r.name room FROM devices d JOIN rooms r ON r.id=d.room_id
   WHERE d.power_on=1 AND d.status='online' AND d.watts>0`).all()

function openSeg(d, at) {
  stmts.upsertSeg.run(d.id, d.name, d.room, d.watts, at.toISOString())
}

// 落库一段 [startMs,endMs) 的用电：跨本地整点自动拆行，每个分片携带各自的
// 功率×时长 kWh。自然日 / 周（周一起）/ 月边界全部落在整点上，因此拆行后
// 任何周期窗口都能严格按区间取数，跨周期段不会整段掉进新周期。
function insertSegKwh(base, startMs, endMs, totalKwh) {
  for (const p of splitByHour(startMs, endMs)) {
    const kwh = round4(totalKwh * p.frac)
    if (kwh <= 0) continue
    const start = new Date(p.start)
    const end = new Date(p.end)
    stmts.insertRec.run(base.device_id, base.device_name, base.room, base.watts, kwh,
      start.toISOString(), end.toISOString(), start.getHours())
  }
}

// 结段：功率(W)×时长(ms) → kWh；跨整点拆行；零电量段不落记录
function closeSeg(s, at) {
  const startMs = new Date(s.start_time).getTime()
  const endMs = at.getTime()
  stmts.delSeg.run(s.device_id)
  if (endMs <= startMs) return 0
  const kwh = round4((s.watts * (endMs - startMs)) / 3_600_000_000)
  if (kwh > 0) insertSegKwh(s, startMs, endMs, kwh)
  return kwh
}

// 设备状态（开关 / 功率 / 名称 / 房间 / 在线状态）发生任何变化后调用：
// 旧段按旧快照结落，当前确实在运行（开机+在线+功率>0）才开新段。
export function reconcileDevice(deviceId, at = new Date()) {
  const seg = stmts.getSeg.get(deviceId)
  if (seg) closeSeg(seg, at)
  const d = stmts.deviceById.get(deviceId)
  if (d && d.power_on === 1 && d.status === 'online' && d.watts > 0) openSeg(d, at)
}

// 删除设备前调用：把未结段结落（记录因无外键级联而保留），随后即可安全删除设备
export function closeDevice(deviceId, at = new Date()) {
  const seg = stmts.getSeg.get(deviceId)
  if (seg) closeSeg(seg, at)
}

function flushAll(at = new Date()) {
  for (const s of stmts.allSegs.all()) closeSeg(s, at)
}

// 模拟运行节拍：所有运行中设备结段续开；并兜底处理绕过 API 的状态变化
function tick() {
  const at = new Date()
  for (const s of stmts.allSegs.all()) {
    const d = stmts.deviceById.get(s.device_id)
    if (!d) {
      // 设备已不在（异常路径残留），直接丢弃段，不再替它记账
      stmts.delSeg.run(s.device_id)
      continue
    }
    if (d.power_on !== 1 || d.status !== 'online' || d.watts <= 0) {
      closeSeg(s, at)
      continue
    }
    if (s.watts !== d.watts || s.device_name !== d.name || s.room !== d.room) {
      // 快照漂移（改名/换房/改功率未走 API 的兜底）：按分段规则结旧开新
      reconcileDevice(d.id, at)
      continue
    }
    closeSeg(s, at)
    openSeg(d, at)
  }
  db.prepare('DELETE FROM energy_records WHERE end_time < ?')
    .run(new Date(at.getTime() - KEEP_MS).toISOString())
}

// ===== 旧版 energy 表迁移 =====
// 旧表只有 设备名/房间/kwh/小时：名称唯一命中的绑定 device_id；
// 重名或设备已删除的一律不猜绑，device_id 置 NULL、名称房间快照照留。
function migrateLegacyEnergy() {
  const hasLegacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='energy'").get()
  if (!hasLegacy) return
  const rows = db.prepare('SELECT * FROM energy').all()
  if (rows.length) {
    const findByName = db.prepare('SELECT id FROM devices WHERE name=? ORDER BY id')
    const now = new Date()
    const ins = stmts.insertRec
    let unbound = 0
    db.exec('BEGIN')
    try {
      for (const r of rows) {
        const m = findByName.all(r.device_name)
        const deviceId = m.length === 1 ? m[0].id : null
        if (m.length !== 1) unbound++
        // 旧数据只有小时没有日期/分钟：还原为「最近一个走到该小时的整点」，
        // 段记为该整点前一整小时，保证 24h 趋势桶位与完整时间齐全。
        const end = new Date(now)
        end.setMinutes(0, 0, 0)
        end.setHours(end.getHours() - ((end.getHours() - r.hour + 24) % 24))
        const start = new Date(end.getTime() - 3600_000)
        ins.run(deviceId, r.device_name, r.room, 0, r.kwh,
          start.toISOString(), end.toISOString(), start.getHours())
      }
      db.exec('DROP TABLE energy')
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    db.prepare('INSERT INTO device_logs (device_name,action,detail,time) VALUES (?,?,?,?)')
      .run('系统', '迁移能耗记录',
        `旧版按小时能耗已导入分段表（${rows.length} 条）` +
        (unbound ? `；${unbound} 条因重名或设备已删除无法绑定标识，已保留名称快照` : ''),
        new Date().toLocaleString('zh-CN'))
  } else {
    db.exec('DROP TABLE energy')
  }
}

// ===== 首次启动的演示数据：近 24h 分段用电，数值与功率/时长自洽 =====
function seedEnergy() {
  if (db.prepare('SELECT COUNT(*) c FROM energy_records').get().c > 0) return
  const devs = db.prepare(`SELECT d.*, r.name room FROM devices d JOIN rooms r ON r.id=d.room_id`).all()
  const now = Date.now()
  const curHourDate = new Date()
  curHourDate.setMinutes(0, 0, 0)
  const curHourStart = curHourDate.getTime()
  const HOUR = 3600_000
  const put = (d, startMs, endMs) => {
    if (endMs <= startMs) return
    const kwh = round4((d.watts * (endMs - startMs)) / 3_600_000_000)
    if (kwh <= 0) return
    const end = new Date(endMs)
    stmts.insertRec.run(d.id, d.name, d.room, d.watts, kwh,
      new Date(startMs).toISOString(), end.toISOString(), end.getHours())
  }
  db.exec('BEGIN')
  try {
    devs.forEach((d, idx) => {
      for (let h = 0; h < 24; h++) {
        const r1 = Math.abs(Math.sin((idx + 1) * 12.9898 + h * 78.233))
        const appear = d.power_on ? r1 > 0.25 : r1 > 0.78
        if (!appear) continue
        const r2 = Math.abs(Math.cos((idx + 3) * 7.17 + h * 3.91))
        const mins = d.power_on ? 6 + Math.floor(r2 * 22) : 2 + Math.floor(r2 * 8)
        // h=23 对应当前小时桶；段整体落在该小时桶内，且不能晚于当前时刻
        const bucketStart = curHourStart - (23 - h) * HOUR
        let endMs = bucketStart + HOUR - 5 * 60_000 - Math.floor(r1 * 40 * 60_000)
        if (h === 23) endMs = Math.min(endMs, now - 60_000)
        const startMs = Math.max(bucketStart + 60_000, endMs - mins * 60_000)
        put(d, startMs, endMs)
      }
    })
    // 给高功率设备注入一个明显尖峰小时，驱动「能耗尖峰」告警演示
    const big = devs.find((d) => d.watts >= 1000)
    if (big) {
      const bucketStart = curHourStart - 3 * HOUR
      put(big, bucketStart + 2 * 60_000, bucketStart + 50 * 60_000)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ===== 重启恢复：上次未结段限时补结并清空段表（运行段在播种后统一重建） =====
function recoverOnStartup() {
  const at = new Date()
  const rows = stmts.allSegs.all()
  if (!rows.length) return
  const nowMs = at.getTime()
  db.exec('BEGIN')
  try {
    for (const s of rows) {
      const startMs = new Date(s.start_time).getTime()
      const endMs = Math.min(nowMs, startMs + MAX_RECOVER_MS)
      if (endMs <= startMs) continue
      const kwh = round4((s.watts * (endMs - startMs)) / 3_600_000_000)
      if (kwh > 0) insertSegKwh(s, startMs, endMs, kwh)
    }
    stmts.clearSegs.run()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ===== 近 24h 聚合：总量 / 24 桶趋势 / 按房间快照 / 按设备标识归组 =====
// 统一按「区间重叠」分摊：查询取与窗口实际相交的段（不能只看 end_time），
// 每条记录按落在窗口内的时长比例计入总量/房间，按落在各小时桶内的时长比例归桶。
// 跨整点的历史记录（旧版库、重启补结的早期数据）无需迁移即可正确分摊。
export function getSummary(at = new Date()) {
  const wEnd = at.getTime()
  const wStart = wEnd - 24 * HOUR_MS
  // 相交条件：start_time < 窗口终点；end_time <= 窗口起点的由分摊函数自然返回 0
  const rows = db.prepare('SELECT * FROM energy_records WHERE start_time < ? ORDER BY end_time')
    .all(new Date(wEnd).toISOString())

  // 24 个小时桶直接对齐 24h 窗口起点（而非当前整点）：桶与窗口同宽、连续铺满，
  // 桶和严格等于窗口总量，窗口边缘不会出现无桶可归的时段；标签取桶起点的钟点
  const trend = Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(wStart + i * HOUR_MS).getHours(),
    v: 0
  }))
  // 小时分片落在哪个窗口桶：分片起点已按整点切齐，只会落进一个桶
  const bucketOf = (sliceStartMs) => {
    const bi = Math.floor((sliceStartMs - wStart) / HOUR_MS)
    return bi >= 0 && bi < 24 ? bi : -1
  }

  const rooms = new Map()
  const groups = new Map()
  const live = new Map(
    db.prepare(`SELECT d.*, r.name room FROM devices d JOIN rooms r ON r.id=d.room_id`).all()
      .map((d) => [d.id, d]))
  let total = 0

  for (const r of rows) {
    const rStart = new Date(r.start_time).getTime()
    const rEnd = new Date(r.end_time).getTime()
    // 整条记录落在 24h 窗口内的部分
    const rv = kwhInWindow(r.kwh, rStart, rEnd, wStart, wEnd)
    if (rv <= 0) continue
    total += rv
    rooms.set(r.room, (rooms.get(r.room) || 0) + rv)

    // 分组键始终用稳定的设备标识：改名/换房/删除前后同 device_id 都是同一组；
    // 仅旧数据（device_id 为空，重名/已删无法绑定）才按名称快照分组
    const cur = r.device_id == null ? null : live.get(r.device_id)
    const key = r.device_id == null ? `n${r.device_name}` : `i${r.device_id}`
    let g = groups.get(key)
    if (!g) {
      g = {
        device_id: r.device_id,
        name: cur ? cur.name : r.device_name,
        room: cur ? cur.room : r.room,
        lastEnd: r.end_time,
        unbound: r.device_id == null,
        deleted: !cur && r.device_id != null,
        v: 0,
        buckets: new Map()
      }
      groups.set(key, g)
    }
    g.v += rv
    // 按小时分片归桶：同一条跨小时记录的电量按重叠时长拆进对应桶；
    // 归桶必须用窗口截断后的起点 s（窗口边缘的分片可能只有一部分落在 24h 内）
    forEachHourSlice(rStart, rEnd, wStart, wEnd, (s, e) => {
      const bi = bucketOf(s)
      if (bi < 0) return
      const partKwh = r.kwh * ((e - s) / (rEnd - rStart))
      g.buckets.set(bi, (g.buckets.get(bi) || 0) + partKwh)
      trend[bi].v += partKwh
    })
    // 设备已删除：用时间最新的历史快照作为它的名字/房间
    if (g.deleted && r.end_time > g.lastEnd) { g.lastEnd = r.end_time; g.name = r.device_name; g.room = r.room }
  }

  const devices = [...groups.values()].map((g) => {
    const bv = [...g.buckets.values()]
    const peak = bv.length ? Math.max(...bv) : 0
    const avg = bv.length ? bv.reduce((a, b) => a + b, 0) / bv.length : 0
    return {
      device_id: g.device_id, device_name: g.name, room: g.room,
      deleted: g.deleted, unbound: g.unbound,
      v: round4(g.v), peak: round4(peak), avg: round4(avg), active_buckets: bv.length
    }
  }).sort((a, b) => b.v - a.v)

  return {
    total: round4(total),
    generated_at: at.toISOString(),
    trend: trend.map((t) => ({ hour: t.hour, v: round4(t.v) })),
    rooms: [...rooms.entries()].map(([room, v]) => ({ room, v: round4(v) })).sort((a, b) => b.v - a.v),
    devices
  }
}
