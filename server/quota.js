// ===== 能耗定额与超标预警闭环 =====
// 按「房间」或「设备」配置 日/周/月 周期额度（kWh）。评估器持续把
// energy_records 中已结分段 + energy_segments 中未结运行段（功率×时长实时
// 折算）聚合到当前周期用量，达到额度 80% 触发预警、100% 触发超标告警。
//
// 闭环：告警身份 = 额度 × 周期粒度 × 周期起点，同一身份只保留一条；
// 预警可升级为超标（不重复打扰）；额度上调后误报自动解除、下调后重新越线可重开重报；
// 告警保留 待处理→处理中→已处理/已忽略 状态与备注；额度调整留痕可追溯；
// 跨周期旧告警自动结转关闭、换周期旧周期告警按快照结存；额度停用/删除后未关闭告警自动解除。

const TICK_MS = 30_000          // 与 energy.js 模拟节拍一致：持续聚合、及时触发
const WARN_RATIO = 0.8          // 用量达额度 80% 预警
const MAX_LIVE_MS = 3600_000    // 未结段实时折算最长补 1h（服务重启等场景兜底）

// 区间分摊口径与 energy.js 完全一致：跨周期的已结段按重叠时长比例计入周期窗口，
// 未结运行段同样按 [周期起点, now] 折算——跨周期段不再被整段计入新周期造成虚高误报
import { round4 } from './prorate.js'

const PERIOD_LABEL = { daily: '每日', weekly: '每周', monthly: '每月' }
const STATUS_LABEL = { open: '待处理', handling: '处理中', resolved: '已处理', ignored: '已忽略' }
// 合法的人工状态流转：resolved/ignored 只能先「重新打开」回到待处理
const NEXT_STATUS = {
  open: ['handling', 'resolved', 'ignored'],
  handling: ['open', 'resolved', 'ignored'],
  resolved: ['open'],
  ignored: ['open']
}

let db
let stmts
// 通过注入回调写日志/通知，避免与 index.js 循环依赖
let notify = () => {}

// ===== 周期用量累计表 =====
// energy_records 明细只保留 7 天，而周/月周期窗口可达 7/31 天，周期用量不能
// 每次都从明细实时聚合——否则月初的用电会随明细清理陆续「蒸发」，月累计
// 单调缩水，评估器据此把仍在超标的告警误判为「用量回落」而自动解除。
// 这里对每条已结明细只消费一次（游标水位 = 已入账的最大 record id，单调前进），
// 按与周期窗口的重叠时长分摊追加到 quota_usage 桶；桶内累计不随明细删除减少。
// 周期用量 = 桶内已累计（全部已结明细）+ 未结运行段实时折算（沿用既有口径）。
// 额度删除不清理累计桶：周期已结束的桶作为历史留存，重建同配置额度仍可追溯。
//
// 首次迁移全量回填时，库里若已发生过明细清理（月初明细已不存在），用该桶对应
// 周期的历史告警 used_kwh 快照作为兜底下限（MAX）：快照只可能略大于真实值
// （含过不超过一次未结段实时折算、上限 1h 运行电量），绝不会把已超标的周期
// 兜底成未超标，避免既有库升级后误解除/不重开。
function migrateUsageTables() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS quota_usage (
    quota_id INTEGER NOT NULL,            -- 额度删除后桶仍保留（历史留存）
    period TEXT NOT NULL,                 -- daily / weekly / monthly
    period_start TEXT NOT NULL,           -- 周期起点（本地零点 ISO）
    period_end TEXT NOT NULL,
    settled_kwh REAL NOT NULL DEFAULT 0,  -- 已结明细按重叠时长分摊后的累计（只增不减）
    updated_at TEXT NOT NULL,
    PRIMARY KEY (quota_id, period, period_start)
  );
  CREATE TABLE IF NOT EXISTS quota_usage_cursors (
    quota_id INTEGER NOT NULL,
    period TEXT NOT NULL,                 -- 额度换周期时删除新粒度游标 → 触发该粒度全量回填
    last_record_id INTEGER NOT NULL DEFAULT 0,  -- 已入账的最大 energy_records.id（水位线）
    updated_at TEXT NOT NULL,
    PRIMARY KEY (quota_id, period)
  );
  `)
}

// ===== 告警表建表 / 旧库迁移 =====
// 旧版唯一键 UNIQUE(quota_id, period_start) 不含周期粒度：额度换周期且新旧窗口起点
// 相同时（如周一 日→周），旧告警会被新周期窗口错误认领，沿用旧 period/阈值。
// 迁移到 UNIQUE(quota_id, period, period_start)，历史行原样保留。
function migrateAlertsTable() {
  const cols = db.prepare("PRAGMA table_info(quota_alerts)").all()
  const fresh = cols.length === 0
  if (fresh) {
    db.exec(`
    CREATE TABLE quota_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quota_id INTEGER NOT NULL,         -- 额度删除不级联，告警按快照保留
      scope TEXT NOT NULL,
      target_name TEXT NOT NULL,
      period TEXT NOT NULL,
      period_start TEXT NOT NULL,        -- 告警所属周期起点（本地零点 ISO）
      period_end TEXT NOT NULL,
      level TEXT NOT NULL,               -- warn(80%) / error(100%)
      used_kwh REAL NOT NULL,
      limit_kwh REAL NOT NULL,           -- 最近一次系统同步时的阈值快照（当前周期告警始终跟随现额度）
      status TEXT NOT NULL DEFAULT 'open',  -- open / handling / resolved / ignored
      note TEXT NOT NULL DEFAULT '',
      auto_closed INTEGER NOT NULL DEFAULT 0, -- 1=系统自动解除（可同周期再越线重开重报）；人工处理后归 0
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      handled_at TEXT,
      UNIQUE(quota_id, period, period_start)
    );
    CREATE INDEX idx_quota_alerts_status ON quota_alerts(status);
    CREATE INDEX idx_quota_alerts_quota ON quota_alerts(quota_id);
    `)
    return
  }
  const hasAutoClosed = cols.some((c) => c.name === 'auto_closed')
  const idx = db.prepare("PRAGMA index_list(quota_alerts)").all()
    .find((i) => i.unique && db.prepare(`PRAGMA index_info('${i.name}')`).all()
      .map((c) => c.name).join(',') === 'quota_id,period,period_start')
  if (hasAutoClosed && idx) return
  db.exec('PRAGMA foreign_keys=OFF')
  db.exec(`
  ALTER TABLE quota_alerts RENAME TO quota_alerts_old;
  CREATE TABLE quota_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quota_id INTEGER NOT NULL,
    scope TEXT NOT NULL,
    target_name TEXT NOT NULL,
    period TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    level TEXT NOT NULL,
    used_kwh REAL NOT NULL,
    limit_kwh REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    note TEXT NOT NULL DEFAULT '',
    auto_closed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    handled_at TEXT,
    UNIQUE(quota_id, period, period_start)
  );
  INSERT INTO quota_alerts
    (id,quota_id,scope,target_name,period,period_start,period_end,level,used_kwh,limit_kwh,status,note,auto_closed,created_at,updated_at,handled_at)
  SELECT id,quota_id,scope,target_name,period,period_start,period_end,level,used_kwh,limit_kwh,status,note,0,created_at,updated_at,handled_at
  FROM quota_alerts_old;
  DROP TABLE quota_alerts_old;
  CREATE INDEX IF NOT EXISTS idx_quota_alerts_status ON quota_alerts(status);
  CREATE INDEX IF NOT EXISTS idx_quota_alerts_quota ON quota_alerts(quota_id);
  `)
  db.exec('PRAGMA foreign_keys=ON')
}

export function initQuota(database, notifyFn) {
  db = database
  if (typeof notifyFn === 'function') notify = notifyFn
  db.exec(`
  CREATE TABLE IF NOT EXISTS energy_quotas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,               -- room / device
    room_id INTEGER,                   -- scope=room 时指向 rooms.id
    device_id INTEGER,                 -- scope=device 时的稳定标识（不设级联：设备删除后历史保留）
    target_name TEXT NOT NULL,         -- 房间名/设备名快照（设备删除后仍可展示）
    period TEXT NOT NULL,              -- daily / weekly / monthly
    limit_kwh REAL NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_energy_quotas_scope ON energy_quotas(scope);
  CREATE TABLE IF NOT EXISTS quota_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quota_id INTEGER NOT NULL,
    action TEXT NOT NULL,             -- create / update / enable / disable / delete
    old_limit REAL,
    new_limit REAL,
    old_period TEXT,
    new_period TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quota_adjustments_quota ON quota_adjustments(quota_id);
  `)
  // 告警表：身份唯一键必须包含 period（额度调整周期后旧周期告警结存，新周期另立身份）
  migrateAlertsTable()
  migrateUsageTables()
  stmts = {
    allQuotas: db.prepare('SELECT * FROM energy_quotas ORDER BY id'),
    quotaById: db.prepare('SELECT * FROM energy_quotas WHERE id=?'),
    roomName: db.prepare('SELECT name FROM rooms WHERE id=?'),
    insertQuota: db.prepare(`INSERT INTO energy_quotas
      (scope,room_id,device_id,target_name,period,limit_kwh,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`),
    updateQuota: db.prepare('UPDATE energy_quotas SET limit_kwh=?,period=?,enabled=?,updated_at=? WHERE id=?'),
    deleteQuota: db.prepare('DELETE FROM energy_quotas WHERE id=?'),
    insertAdj: db.prepare(`INSERT INTO quota_adjustments
      (quota_id,action,old_limit,new_limit,old_period,new_period,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?)`),
    adjByQuota: db.prepare('SELECT * FROM quota_adjustments WHERE quota_id=? ORDER BY id DESC LIMIT 30'),
    allAdj: db.prepare(`SELECT a.*, q.scope, q.target_name FROM quota_adjustments a
                        LEFT JOIN energy_quotas q ON q.id=a.quota_id
                        ORDER BY a.id DESC LIMIT 50`),
    // 取「与周期窗口相交」的已结段（不能只按 end_time 过滤），用量在 computeUsage 内按重叠时长分摊
    recRoom: db.prepare('SELECT * FROM energy_records WHERE room=? AND start_time < ? AND end_time > ?'),
    recDevice: db.prepare('SELECT * FROM energy_records WHERE device_id=? AND start_time < ? AND end_time > ?'),
    segRoom: db.prepare('SELECT * FROM energy_segments WHERE room=?'),
    segDevice: db.prepare('SELECT * FROM energy_segments WHERE device_id=?'),
    // 当前周期窗口的告警：身份 = 额度 × 周期粒度 × 周期起点
    activeAlert: db.prepare('SELECT * FROM quota_alerts WHERE quota_id=? AND period=? AND period_start=?'),
    alertById: db.prepare('SELECT * FROM quota_alerts WHERE id=?'),
    insertAlert: db.prepare(`INSERT INTO quota_alerts
      (quota_id,scope,target_name,period,period_start,period_end,level,used_kwh,limit_kwh,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'open',?,?)`),
    // 活动告警级别/读数/阈值/周期窗口整体同步（升级、降级都走它，避免旧阈值旧周期残留）
    raiseAlert: db.prepare('UPDATE quota_alerts SET level=?,used_kwh=?,limit_kwh=?,period_end=?,updated_at=? WHERE id=?'),
    touchAlert: db.prepare('UPDATE quota_alerts SET used_kwh=?,limit_kwh=?,updated_at=? WHERE id=?'),
    // 系统自动解除关闭：置 auto_closed=1，允许同周期再次越线时重开重报
    sysCloseAlert: db.prepare(`UPDATE quota_alerts SET status='ignored',note=?,handled_at=?,updated_at=?,auto_closed=1
                               WHERE id=?`),
    // 系统重开（仅限 auto_closed=1 的已关闭告警）：状态/级别/阈值/窗口全部按当前身份重算
    reopenAlert: db.prepare(`UPDATE quota_alerts SET status='open',level=?,used_kwh=?,limit_kwh=?,
                             period_end=?,note='',handled_at=NULL,auto_closed=0,
                             created_at=?,updated_at=? WHERE id=?`),
    // 人工操作：auto_closed 一律归零（用户处理过的告警不再被系统自动复活）
    manualAlert: db.prepare('UPDATE quota_alerts SET status=?,note=?,handled_at=?,auto_closed=0,updated_at=? WHERE id=?'),
    openAlerts: db.prepare("SELECT * FROM quota_alerts WHERE status IN ('open','handling')"),
    staleByQuota: db.prepare(`SELECT * FROM quota_alerts WHERE quota_id=? AND status IN ('open','handling')
                              AND (period<>? OR period_start<>?)`),
    disabledByQuota: db.prepare("SELECT * FROM quota_alerts WHERE quota_id=? AND status IN ('open','handling')"),
    // ===== 周期用量累计桶 / 消费游标 =====
    getCursor: db.prepare('SELECT last_record_id FROM quota_usage_cursors WHERE quota_id=? AND period=?'),
    // 增量：仅消费水位线之后、且已结束的新明细（end_time < now，剔除极端时钟错乱行）
    newRecsRoom: db.prepare('SELECT * FROM energy_records WHERE id>? AND room=? AND end_time<=? ORDER BY id'),
    newRecsDevice: db.prepare('SELECT * FROM energy_records WHERE id>? AND device_id=? AND end_time<=? ORDER BY id'),
    // 全量回填：重新扫描与周期相关的全部现存明细（重建桶，不与旧值相加）
    allRecsRoom: db.prepare('SELECT * FROM energy_records WHERE room=? ORDER BY id'),
    allRecsDevice: db.prepare('SELECT * FROM energy_records WHERE device_id=? ORDER BY id'),
    maxRecId: db.prepare('SELECT MAX(id) m FROM energy_records'),
    // 回填兜底映射在 backfillExistingUsage 内按额度分组预构建（GROUP BY period_start）
    upsertUsageAdd: db.prepare(`INSERT INTO quota_usage
      (quota_id,period,period_start,period_end,settled_kwh,updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(quota_id,period,period_start) DO UPDATE SET
        settled_kwh=settled_kwh+excluded.settled_kwh,
        period_end=excluded.period_end, updated_at=excluded.updated_at`),
    upsertUsageMax: db.prepare(`INSERT INTO quota_usage
      (quota_id,period,period_start,period_end,settled_kwh,updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(quota_id,period,period_start) DO UPDATE SET
        settled_kwh=MAX(settled_kwh,excluded.settled_kwh),
        period_end=excluded.period_end, updated_at=excluded.updated_at`),
    getUsage: db.prepare('SELECT settled_kwh FROM quota_usage WHERE quota_id=? AND period=? AND period_start=?'),
    upsertCursor: db.prepare(`INSERT INTO quota_usage_cursors (quota_id,period,last_record_id,updated_at)
      VALUES (?,?,?,?)
      ON CONFLICT(quota_id,period) DO UPDATE SET last_record_id=excluded.last_record_id,updated_at=excluded.updated_at`),
    delCursorPeriod: db.prepare('DELETE FROM quota_usage_cursors WHERE quota_id=? AND period=?'),
    delUsagePeriod: db.prepare('DELETE FROM quota_usage WHERE quota_id=? AND period=?')
  }

  seedQuotas()
  // 兼容旧库：为已有额度回填周期累计桶（现存明细全量重算 + 历史告警快照兜底
  // 已被 7 天清理删除的部分），必须在首次评估前完成，避免缩水读数误解除告警
  backfillExistingUsage(new Date())
  // 首次启动播种后立即评估一次，让看板开箱即有闭环演示数据
  evaluateAll(new Date())
  setInterval(() => { try { evaluateAll(new Date()) } catch (e) { console.error('[QUOTA] tick error', e) } }, TICK_MS)
}

// ===== 周期窗口 =====
export function periodRange(period, at = new Date()) {
  const end = new Date(at)
  const start = new Date(at)
  if (period === 'daily') {
    start.setHours(0, 0, 0, 0)
    end.setHours(24, 0, 0, 0)
  } else if (period === 'weekly') {
    // 周一为一周起点
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
    end.setTime(start.getTime())
    end.setDate(end.getDate() + 7)
  } else {
    start.setHours(0, 0, 0, 0)
    start.setDate(1)
    end.setTime(start.getTime())
    end.setMonth(end.getMonth() + 1)
  }
  return { start, end }
}

// 枚举一条已结明细按重叠时长覆盖到的周期窗口：日/周桶几乎总在整点对齐的
// 单日内只命中一个桶；跨周期（跨零点/周一/月初）长段（旧库未拆行等）命中多个，
// 按 功率等价的重叠时长比例 分别分摊。
function periodWindowsCovered(period, startMs, endMs) {
  const out = []
  let { start, end } = periodRange(period, new Date(startMs))
  // 防御：异常旧数据不参与分摊，限制循环上限避免脏行造成死循环
  for (let guard = 0; start.getTime() < endMs && guard < 400; guard++) {
    out.push({ startMs: start.getTime(), endMs: end.getTime() })
    start = new Date(end)
    end = nextPeriodEnd(period, start)
  }
  return out
}

function nextPeriodEnd(period, start) {
  const end = new Date(start)
  if (period === 'daily') end.setDate(end.getDate() + 1)
  else if (period === 'weekly') end.setDate(end.getDate() + 7)
  else end.setMonth(end.getMonth() + 1)
  return end
}

// 把一条已结明细按与各周期窗口的重叠时长分摊入账（累计桶只增不减）
function ingestRecord(q, rec, upsertStmt, atIso) {
  const rStart = new Date(rec.start_time).getTime()
  const rEnd = new Date(rec.end_time).getTime()
  if (rEnd <= rStart) return
  for (const w of periodWindowsCovered(q.period, rStart, rEnd)) {
    const s = Math.max(rStart, w.startMs)
    const e = Math.min(rEnd, w.endMs)
    if (e <= s) continue
    const kwh = round4(rec.kwh * ((e - s) / (rEnd - rStart)))
    if (kwh <= 0) continue
    upsertStmt.run(q.id, q.period, new Date(w.startMs).toISOString(),
      new Date(w.endMs).toISOString(), kwh, atIso)
  }
}

// 同步某额度某周期粒度的已结明细累计桶。
// - 正常（游标存在）：增量消费水位线之后的新明细，游标只前进、桶只累加；
//   明细被清理只影响尚未消费的行，已入账电量永久保留，周期累计不缩水。
// - 无游标（新建额度 / 换周期后 / 首次迁移）：全量重扫现存明细重建该粒度各桶，
//   游标直接推到当前最大 record id（避免之后增量重复入账）。floorMap 存在时
//   （仅兼容旧库迁移）再用历史告警读数快照兜底已被清理删除的明细部分。
function syncUsage(q, at = new Date(), { full = false, floorMap = null } = {}) {
  if (!q.id) return
  const atIso = at.toISOString()
  const cursor = stmts.getCursor.get(q.id, q.period)
  const fullScan = full || !cursor
  const maxId = stmts.maxRecId.get().m ?? 0

  if (fullScan) {
    // 重建语义：先清掉该额度当前粒度的全部桶再重扫（换粒度不影响其他粒度旧桶），
    // 保证回填可重复执行、绝不与既有值相加
    stmts.delUsagePeriod.run(q.id, q.period)
    const recs = q.scope === 'room'
      ? stmts.allRecsRoom.all(q.target_name)
      : stmts.allRecsDevice.all(q.device_id)
    for (const r of recs) {
      if (new Date(r.end_time).getTime() > at.getTime()) continue
      ingestRecord(q, r, stmts.upsertUsageAdd, atIso)
    }
    if (floorMap) {
      // 对每个有快照的历史周期取 MAX 兜底：即使该周期明细已全部被清理（扫描建不出桶），
      // 也按快照建立累计桶，保证升级后仍超标的旧周期读数不塌、告警不被误解除。
      // floorMap 仅含终点早于明细保留线的周期，进行中周期绝不在其中（避免重复折算）。
      for (const [ps, floor] of Object.entries(floorMap)) {
        if (floor == null) continue
        const { end: pe } = periodRange(q.period, new Date(new Date(ps).getTime() + 3600_000))
        stmts.upsertUsageMax.run(q.id, q.period, ps, pe.toISOString(), round4(floor), atIso)
      }
    }
    stmts.upsertCursor.run(q.id, q.period, maxId, atIso)
    return
  }

  const recs = q.scope === 'room'
    ? stmts.newRecsRoom.all(cursor.last_record_id, q.target_name, atIso)
    : stmts.newRecsDevice.all(cursor.last_record_id, q.device_id, atIso)
  let watermark = cursor.last_record_id
  for (const r of recs) {
    ingestRecord(q, r, stmts.upsertUsageAdd, atIso)
    // 水位线只推进到实际消费的行（查询已限定 end_time<=now）；极端时钟错乱
    // 产生的未来行会在下一节拍「老化」后自然被补消费，绝不因水位线跳空而漏账
    if (r.id > watermark) watermark = r.id
  }
  stmts.upsertCursor.run(q.id, q.period, watermark, atIso)
}

// 首次启动：为已有额度建立累计桶（全量回填现存明细 + 告警快照兜底被清理部分）
function backfillExistingUsage(at = new Date()) {
  for (const q of stmts.allQuotas.all()) {
    // 每个周期起点取历史告警最大读数（含已解除/已处理）。旧版评估器的读数 =
    // 现存明细分摊 + 未结段折算（≤1h 电量），周期内用量单调不减，故该最大值是
    // 被 7 天清理删除部分的可靠下限：现存明细重算小于它时一律抬到快照值，
    // 升级瞬间绝不把仍在超标的进行中周期误判为回落而解除告警。
    // 快照可能含过至多 1h 实时折算，抬升后该周期用量最多高估 1h 电量（千分级），
    // 且只影响当前这一个周期，跨期后从新桶重新累计。
    const floorMap = {}
    for (const a of db.prepare(
      'SELECT period_start, MAX(used_kwh) m FROM quota_alerts WHERE quota_id=? AND period=? GROUP BY period_start'
    ).all(q.id, q.period)) floorMap[a.period_start] = a.m
    syncUsage(q, at, { full: true, floorMap })
  }
}

// 当前周期已用电量 = 已结明细累计桶（与明细 7 天保留期无关，只增不减）
// + 未结运行段实时折算（周期起点之后的功率×时长，重启折算上限 1h）。
// 跨周期运行段只计入本周期内的部分，不会因结段时刻落在新周期而整段计入新周期。
function computeUsage(quota, at = new Date()) {
  const { start, end } = periodRange(quota.period, at)
  const startMs = start.getTime()
  const endMs = end.getTime()
  const atMs = at.getTime()
  const wEnd = Math.min(endMs, atMs)
  let v = 0

  if (quota.id) {
    const row = stmts.getUsage.get(quota.id, quota.period, start.toISOString())
    if (row) v += row.settled_kwh
  } else {
    // 临时对象（播种时额度尚未落库，无 id/桶）：退化为直接聚合现存明细
    const recs = quota.scope === 'room'
      ? stmts.recRoom.all(quota.target_name, new Date(wEnd).toISOString(), start.toISOString())
      : stmts.recDevice.all(quota.device_id, new Date(wEnd).toISOString(), start.toISOString())
    for (const r of recs) {
      const rStart = new Date(r.start_time).getTime()
      const rEnd = new Date(r.end_time).getTime()
      if (rEnd <= rStart) continue
      const s = Math.max(rStart, startMs)
      const e = Math.min(rEnd, wEnd)
      if (e > s) v += r.kwh * ((e - s) / (rEnd - rStart))
    }
  }

  const segs = quota.scope === 'room'
    ? stmts.segRoom.all(quota.target_name)
    : stmts.segDevice.all(quota.device_id)
  for (const s of segs) {
    const segStart = Math.max(new Date(s.start_time).getTime(), startMs)
    const dur = Math.min(atMs - segStart, MAX_LIVE_MS)
    if (dur > 0) v += (s.watts * dur) / 3_600_000_000
  }
  return round4(v)
}

// ===== 核心评估：全量额度聚合 → 触发/升级/降级/解除/重开；跨周期、停用与已删额度结转 =====
export function evaluateAll(at = new Date()) {
  const quotas = stmts.allQuotas.all()
  const liveQuotaIds = new Set(quotas.map((q) => q.id))
  let changed = false
  // 本次评估产生的通知，先关后开，最后按顺序统一写入时间线，避免同一身份同节拍重复通知
  const events = []
  const atIso = at.toISOString()
  const sysClose = (a, reason, logFn) => {
    stmts.sysCloseAlert.run(appendNote(a.note, reason), atIso, atIso, a.id)
    events.push({ logFn })
    changed = true
  }

  for (const q of quotas) {
    const { start, end } = periodRange(q.period, at)
    const startIso = start.toISOString()

    // 先把本节拍新结落的明细增量计入累计桶（停用期间也照常记账，
    // 重新启用后周期用量连续，不因停用断档）
    syncUsage(q, at)

    // 跨周期 / 换周期：不属于当前周期身份的未关闭告警，按其旧周期快照结存关闭
    // （周期调整造成的身份切换写「调整周期」，自然跨周期写「周期结束」）
    for (const old of stmts.staleByQuota.all(q.id, q.period, startIso)) {
      const reason = old.period !== q.period
        ? `定额周期已由${PERIOD_LABEL[old.period]}调整为${PERIOD_LABEL[q.period]}，旧周期告警结存关闭`
        : '周期结束自动结转关闭'
      sysClose(old, reason, () => buildCloseLog(old, reason))
    }

    if (!q.enabled) {
      // 停用额度：其当前窗口未关闭告警立即解除，避免停用后继续误报
      // （旧窗口的已在上一步「结存关闭」处理，此查询取的是结存后的最新状态）
      for (const old of stmts.disabledByQuota.all(q.id)) {
        sysClose(old, '定额已停用，告警自动解除', () => buildCloseLog(old, '定额已停用，告警自动解除'))
      }
      continue
    }

    const used = computeUsage(q, at)
    const ratio = used / q.limit_kwh
    const level = ratio >= 1 ? 'error' : ratio >= WARN_RATIO ? 'warn' : null
    const alert = stmts.activeAlert.get(q.id, q.period, startIso)

    if (!alert) {
      if (level) {
        stmts.insertAlert.run(q.id, q.scope, q.target_name, q.period,
          startIso, end.toISOString(), level, used, q.limit_kwh, atIso, atIso)
        events.push({ logFn: () => buildAlertLog(q, level, used) })
        changed = true
      }
      continue
    }

    const active = alert.status === 'open' || alert.status === 'handling'
    if (!level) {
      // 额度上调（或自然回落）导致用量低于预警线：该配置下的告警生命周期结束，
      // 无论此前是活动态还是用户已忽略，统一按系统解除结存（auto_closed=1，允许再越线重开）
      const reason = `用量已回落至预警线以下（当前额度 ${q.limit_kwh}kWh），告警自动解除`
      sysClose(alert, reason, () => buildCloseLog(alert, reason))
    } else if (active) {
      if (alert.level !== level || Math.abs(alert.limit_kwh - q.limit_kwh) >= 0.0001
          || alert.period_end !== end.toISOString()) {
        // 升级（warn→error，通知）或下调额度后的降级（error→warn，静默不重复通知）；
        // 阈值/周期窗口同步刷新，告警中心与看板不再出现旧阈值旧百分比
        stmts.raiseAlert.run(level, used, q.limit_kwh, end.toISOString(), atIso, alert.id)
        if (alert.level !== level)
          events.push({ logFn: () => buildAlertLog(q, level, used), notify: alert.level === 'warn' && level === 'error' })
        changed = true
      } else if (Math.abs(alert.used_kwh - used) >= 0.0001 || Math.abs(alert.limit_kwh - q.limit_kwh) >= 0.0001) {
        // 读数持续变化：同步用量与当前阈值
        stmts.touchAlert.run(used, q.limit_kwh, atIso, alert.id)
        changed = true
      }
    } else if (alert.auto_closed) {
      // 系统自动解除（调额/停用/结转）后，同周期再次越线：重开并按新阈值通知一次
      stmts.reopenAlert.run(level, used, q.limit_kwh, end.toISOString(), atIso, atIso, alert.id)
      events.push({ logFn: () => buildAlertLog(q, level, used) })
      changed = true
    } else if (Math.abs(alert.used_kwh - used) >= 0.0001 || Math.abs(alert.limit_kwh - q.limit_kwh) >= 0.0001) {
      // 用户已闭环（resolved/ignored）且仍越线：只校准读数/阈值快照，不复活状态，不重复通知
      stmts.touchAlert.run(used, q.limit_kwh, atIso, alert.id)
      changed = true
    }
  }

  // 额度已删除：残留未关闭告警自动解除
  for (const a of stmts.openAlerts.all()) {
    if (!liveQuotaIds.has(a.quota_id)) {
      sysClose(a, '定额已删除，告警自动解除', () => buildCloseLog(a, '定额已删除，告警自动解除'))
    }
  }

  // 统一发通知：触发/升级/重开与系统解除均写入时间线；仅级别下调静默（不打扰）
  for (const e of events) {
    if (e.notify === false) continue
    notify(e.logFn(), at.toLocaleString('zh-CN'))
  }
  return changed
}

function appendNote(note, text) {
  return note ? `${note} ｜ ${text}` : text
}

function buildAlertLog(q, level, used) {
  const tag = level === 'error' ? '超标告警' : '超标预警'
  return {
    device: level === 'error' ? '🚨' : '⚠️',
    action: `能耗${tag}`,
    detail: `${q.scope === 'room' ? '房间' : '设备'}「${q.target_name}」${PERIOD_LABEL[q.period]}定额 ${q.limit_kwh}kWh，当前已用 ${used.toFixed(2)}kWh（${Math.round((used / q.limit_kwh) * 100)}%）`
  }
}

// 系统自动解除/结存关闭：以告警自身的旧快照记录（历史归属不被新周期/新阈值改写）
function buildCloseLog(a, reason) {
  return {
    device: '✅',
    action: '定额告警自动解除',
    detail: `${a.scope === 'room' ? '房间' : '设备'}「${a.target_name}」${PERIOD_LABEL[a.period]}${a.level === 'error' ? '超标告警' : '预警'}：${reason}`
  }
}

// ===== 额度增改删（均留痕） =====
function snapshotName(scope, roomId, deviceId) {
  if (scope === 'room') {
    const r = stmts.roomName.get(roomId)
    if (!r) throw new Error('房间不存在')
    return r.name
  }
  const d = db.prepare('SELECT d.name FROM devices d WHERE d.id=?').get(deviceId)
  if (!d) throw new Error('设备不存在')
  return d.name
}

export function createQuota({ scope, room_id, device_id, period, limit_kwh, reason = '' }) {
  if (!['room', 'device'].includes(scope)) throw new Error('定额对象类型无效')
  if (!['daily', 'weekly', 'monthly'].includes(period)) throw new Error('周期无效')
  const limit = Number(limit_kwh)
  if (!Number.isFinite(limit) || limit <= 0 || limit > 100000) throw new Error('额度需为 0-100000 的正数(kWh)')
  const roomId = scope === 'room' ? Number(room_id) : null
  const deviceId = scope === 'device' ? Number(device_id) : null
  const targetName = snapshotName(scope, roomId, deviceId)

  // 同一对象 + 同一周期只允许一条有效额度，避免重复告警
  const dup = db.prepare('SELECT id FROM energy_quotas WHERE scope=? AND period=? AND COALESCE(room_id,-1)=COALESCE(?,-1) AND COALESCE(device_id,-1)=COALESCE(?,-1)')
    .get(scope, period, roomId, deviceId)
  if (dup) throw new Error('该对象在此周期下已有定额，请直接编辑原额度')

  const at = new Date()
  const r = stmts.insertQuota.run(scope, roomId, deviceId, targetName, period, round4(limit), 1,
    at.toISOString(), at.toISOString())
  stmts.insertAdj.run(r.lastInsertRowid, 'create', null, round4(limit), null, period, reason, at.toISOString())
  evaluateAll(at)
  return r.lastInsertRowid
}

export function updateQuota(id, { limit_kwh, period, enabled, reason = '' }) {
  const q = stmts.quotaById.get(id)
  if (!q) throw new Error('定额不存在')
  const at = new Date()
  const nextLimit = limit_kwh != null ? Number(limit_kwh) : q.limit_kwh
  const nextPeriod = period ?? q.period
  const nextEnabled = enabled != null ? (enabled ? 1 : 0) : q.enabled
  if (!Number.isFinite(nextLimit) || nextLimit <= 0 || nextLimit > 100000) throw new Error('额度需为 0-100000 的正数(kWh)')
  if (!['daily', 'weekly', 'monthly'].includes(nextPeriod)) throw new Error('周期无效')

  // 换周期若与已有额度撞车则拒绝（同一对象+周期唯一）
  if (nextPeriod !== q.period) {
    const dup = db.prepare('SELECT id FROM energy_quotas WHERE id<>? AND scope=? AND period=? AND COALESCE(room_id,-1)=COALESCE(?,-1) AND COALESCE(device_id,-1)=COALESCE(?,-1)')
      .get(id, q.scope, nextPeriod, q.room_id, q.device_id)
    if (dup) throw new Error('该对象在此周期下已有定额，无法切换周期')
  }

  const changes = []
  if (nextLimit !== q.limit_kwh) changes.push(`额度 ${q.limit_kwh}→${round4(nextLimit)}kWh`)
  if (nextPeriod !== q.period) changes.push(`周期 ${PERIOD_LABEL[q.period]}→${PERIOD_LABEL[nextPeriod]}`)
  if (nextEnabled !== q.enabled) changes.push(nextEnabled ? '已启用' : '已停用')
  stmts.updateQuota.run(round4(nextLimit), nextPeriod, nextEnabled, at.toISOString(), id)
  if (nextPeriod !== q.period) {
    // 新粒度若曾用过（切走又切回），游标会跳过其桶覆盖期间的明细：
    // 删除新粒度游标，随后评估走全量重建；旧粒度桶保留为历史留存
    stmts.delCursorPeriod.run(id, nextPeriod)
  }
  stmts.insertAdj.run(id, nextEnabled !== q.enabled ? (nextEnabled ? 'enable' : 'disable') : 'update',
    q.limit_kwh, round4(nextLimit), q.period, nextPeriod,
    reason || changes.join('，'), at.toISOString())
  evaluateAll(at)
  return changes
}

export function deleteQuota(id, reason = '') {
  const q = stmts.quotaById.get(id)
  if (!q) throw new Error('定额不存在')
  const at = new Date()
  stmts.insertAdj.run(id, 'delete', q.limit_kwh, null, q.period, null, reason, at.toISOString())
  stmts.deleteQuota.run(id)
  // 立即解除其未关闭告警
  evaluateAll(at)
}

// ===== 告警处理闭环 =====
// 状态机：open → handling → resolved/ignored，可退回 open；resolved/ignored 只能「重新打开」。
// 重新打开必须重新越线，且自动同步最新周期窗口/阈值，杜绝把历史旧告警误开成新事件。
export function handleAlert(id, { status, note }) {
  const a = stmts.alertById.get(id)
  if (!a) throw new Error('告警不存在')
  if (!['open', 'handling', 'resolved', 'ignored'].includes(status)) throw new Error('处理状态无效')
  if (!NEXT_STATUS[a.status].includes(status))
    throw new Error(`不能从「${STATUS_LABEL[a.status]}」流转到「${STATUS_LABEL[status]}」，请先退回待处理`)

  if (status === 'open') {
    // 重新打开前校验：额度仍在、告警身份仍是当前周期、用量仍越线
    const q = stmts.quotaById.get(a.quota_id)
    if (!q || !q.enabled) throw new Error('定额已停用或删除，无法重新打开')
    const { start, end } = periodRange(q.period)
    if (q.period !== a.period || start.toISOString() !== a.period_start)
      throw new Error('该告警属于已结束的旧周期，不能重新打开')
    const used = computeUsage(q)
    const level = used / q.limit_kwh >= 1 ? 'error' : used / q.limit_kwh >= WARN_RATIO ? 'warn' : null
    if (!level) throw new Error('当前用量已低于预警线，无需重新打开')
    const at = new Date()
    const nextNote = note != null && String(note) ? appendNote(a.note, `重新打开：${String(note)}`) : a.note
    stmts.raiseAlert.run(level, used, q.limit_kwh, end.toISOString(), at.toISOString(), a.id)
    stmts.manualAlert.run('open', nextNote, null, at.toISOString(), a.id)
    return stmts.alertById.get(id)
  }

  const at = new Date()
  const nextNote = note != null ? String(note) : a.note
  const handled = status === 'resolved' || status === 'ignored'
    ? (a.handled_at || at.toISOString())
    : null
  stmts.manualAlert.run(status, nextNote, handled, at.toISOString(), id)
  return stmts.alertById.get(id)
}

// ===== 给 /api/state 的序列化视图 =====
export function listQuotas(at = new Date()) {
  return stmts.allQuotas.all().map((q) => {
    const { start, end } = periodRange(q.period, at)
    const used = q.enabled ? computeUsage(q, at) : 0
    const alert = stmts.activeAlert.get(q.id, q.period, start.toISOString())
    const ratio = q.limit_kwh > 0 ? used / q.limit_kwh : 0
    return {
      id: q.id,
      scope: q.scope,
      room_id: q.room_id,
      device_id: q.device_id,
      target_name: q.target_name,
      period: q.period,
      period_label: PERIOD_LABEL[q.period],
      limit_kwh: q.limit_kwh,
      enabled: !!q.enabled,
      used_kwh: used,
      ratio: Math.round(ratio * 1000) / 10,           // 百分比，保留 1 位
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      device_deleted: q.scope === 'device'
        && !db.prepare('SELECT id FROM devices WHERE id=?').get(q.device_id),
      alert: alert ? {
        id: alert.id, level: alert.level, status: alert.status,
        status_label: STATUS_LABEL[alert.status],
        used_kwh: alert.used_kwh, note: alert.note
      } : null
    }
  })
}

export function listAlerts(at = new Date()) {
  return db.prepare('SELECT * FROM quota_alerts ORDER BY id DESC LIMIT 100').all().map((a) => ({
    id: a.id,
    quota_id: a.quota_id,
    scope: a.scope,
    target_name: a.target_name,
    period: a.period,
    period_label: PERIOD_LABEL[a.period],
    period_start: a.period_start,
    period_end: a.period_end,
    level: a.level,
    used_kwh: a.used_kwh,
    limit_kwh: a.limit_kwh,
    status: a.status,
    status_label: STATUS_LABEL[a.status],
    note: a.note,
    created_at: a.created_at,
    updated_at: a.updated_at,
    handled_at: a.handled_at
  }))
}

export function getAdjustments(quotaId = null) {
  const rows = quotaId ? stmts.adjByQuota.all(quotaId) : stmts.allAdj.all()
  return rows.map((a) => ({
    id: a.id,
    quota_id: a.quota_id,
    scope: a.scope || null,
    target_name: a.target_name || null,
    action: a.action,
    old_limit: a.old_limit,
    new_limit: a.new_limit,
    old_period: a.old_period,
    new_period: a.new_period,
    reason: a.reason,
    created_at: a.created_at
  }))
}

export function activeAlertCount() {
  return db.prepare("SELECT COUNT(*) c FROM quota_alerts WHERE status IN ('open','handling')").get().c
}

// ===== 首次启动演示定额：按「当前周期真实用量」反推额度，保证开箱即触发闭环 =====
function seedQuotas() {
  if (stmts.allQuotas.all().length > 0) return
  const at = new Date()
  // 构造临时额度对象，复用同一套周期聚合口径，避免与实际评估窗口不一致
  const usedOf = (scope, period, roomId, deviceId) => {
    const targetName = scope === 'room' ? stmts.roomName.get(roomId)?.name : null
    return computeUsage({ scope, period, room_id: roomId, device_id: deviceId, target_name: targetName }, at)
  }

  const seeds = []
  // 房间·每日：客厅，额度卡在 80%~100% 之间 → 预警
  const living = stmts.roomName.get(1)
  if (living) {
    const used = usedOf('room', 'daily', 1, null)
    if (used > 0.05) seeds.push({ scope: 'room', room_id: 1, device_id: null, period: 'daily', limit_kwh: round4(used / 0.9), reason: '初始演示额度' })
  }
  // 设备·每日：空调，额度卡在已用量之下 → 直接超标
  const ac = db.prepare("SELECT d.id FROM devices d WHERE d.name LIKE '%空调%' AND d.watts>=1000 ORDER BY d.id LIMIT 1").get()
  if (ac) {
    const used = usedOf('device', 'daily', null, ac.id)
    if (used > 0.05) seeds.push({ scope: 'device', room_id: null, device_id: ac.id, period: 'daily', limit_kwh: round4(used / 1.25), reason: '初始演示额度' })
  }
  // 房间·每周：厨房，额度放宽 → 正常，演示进度条
  const kitchen = stmts.roomName.get(3)
  if (kitchen) {
    const used = usedOf('room', 'weekly', 3, null)
    if (used > 0.01) seeds.push({ scope: 'room', room_id: 3, device_id: null, period: 'weekly', limit_kwh: round4(Math.max(used * 5, 10)), reason: '初始演示额度' })
  }
  // 设备·每月：高功率插座
  const socket = db.prepare("SELECT d.id FROM devices d WHERE d.type_id=6 AND d.watts>=150 ORDER BY d.id LIMIT 1").get()
  if (socket) {
    const used = usedOf('device', 'monthly', null, socket.id)
    if (used > 0.01) seeds.push({ scope: 'device', room_id: null, device_id: socket.id, period: 'monthly', limit_kwh: round4(Math.max(used * 8, 20)), reason: '初始演示额度' })
  }

  for (const s of seeds) {
    try {
      createQuota(s)
    } catch (e) {
      // 演示数据冲突（如重复播种）不阻断启动
      console.warn('[QUOTA] seed skip:', e.message)
    }
  }
}
