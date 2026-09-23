import express from 'express'
import { db } from './db.js'
import { initEnergy, reconcileDevice, closeDevice, getSummary } from './energy.js'
import {
  initQuota, evaluateAll, createQuota, updateQuota, deleteQuota,
  handleAlert, listQuotas, listAlerts, getAdjustments, activeAlertCount
} from './quota.js'

const app = express()
app.use(express.json())

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)
const now = () => new Date().toLocaleString('zh-CN')

// 必须在 db.js 建表/播种完成后初始化能耗模块
initEnergy(db)
// 定额模块依赖分段表：预警/超标触发时通过回调写入日志时间线作为通知
initQuota(db, (entry, timeStr) => {
  run('INSERT INTO device_logs (device_name,action,detail,time) VALUES (?,?,?,?)',
    entry.device, entry.action, entry.detail, timeStr || now())
})

// 追加日志
function log(device, action, detail = '') {
  run('INSERT INTO device_logs (device_name,action,detail,time) VALUES (?,?,?,?)', device, action, detail, now())
  // 保留最近 200 条
  const c = q1('SELECT COUNT(*) c FROM device_logs').c
  if (c > 200) db.exec('DELETE FROM device_logs WHERE id <= (SELECT MAX(id)-200 FROM device_logs)')
}

// ===== 状态聚合 =====
app.get('/api/state', (req, res) => {
  const energy = getSummary()
  res.json({
    rooms: q('SELECT * FROM rooms'),
    types: q('SELECT * FROM device_types'),
    devices: q(`SELECT d.*, r.name room, t.name type_name, t.icon type_icon
                FROM devices d JOIN rooms r ON r.id=d.room_id JOIN device_types t ON t.id=d.type_id`),
    scenes: q('SELECT * FROM scenes').map((s) => {
      const actions = q(`SELECT sa.id, sa.device_id, sa.device_key, sa.action, d.name device_name,
                                (SELECT COUNT(*) FROM devices x WHERE x.name=sa.device_key) key_match_count
                         FROM scene_actions sa LEFT JOIN devices d ON d.id=sa.device_id
                         WHERE sa.scene_id=? ORDER BY sa.order_no, sa.id`, s.id)
        .map((a) => ({
          ...a,
          // device_id 为空时区分原因：同名设备不止一台=迁移时无法判定归属，需人工重新绑定；否则为设备已删除
          unresolved: !a.device_name ? (a.key_match_count > 1 ? 'duplicate' : 'missing') : null
        }))
      return { ...s, action_count: actions.length, actions }
    }),
    logs: q('SELECT * FROM device_logs ORDER BY id DESC LIMIT 50'),
    energy,
    quotas: listQuotas(),
    quota_alerts: listAlerts(),
    alerts: computeAlerts(energy)
  })
})

function computeAlerts(energy) {
  const devs = q('SELECT * FROM devices')
  const alerts = []
  for (const d of devs) {
    if (d.status === 'error') alerts.push({ device: d.name, level: 'error', text: '设备离线/异常' })
    else if (d.battery < 40) alerts.push({ device: d.name, level: 'warn', text: `电量低(${d.battery}%)` })
    else if (d.signal < 60) alerts.push({ device: d.name, level: 'warn', text: `信号弱(${d.signal})` })
  }
  // 能耗尖峰：按设备标识聚合近 24h 的小时桶，存在一个小时明显偏离其活跃时段均值即告警
  // （改名/换房不影响识别；已删除设备不产生尖峰告警）
  for (const d of energy.devices) {
    if (!d.deleted && !d.unbound && d.active_buckets >= 6 && d.peak >= 0.05 && d.avg > 0 && d.peak > d.avg * 3) {
      alerts.push({ device: d.device_name, level: 'info', text: `能耗尖峰：单小时 ${d.peak.toFixed(2)}kWh，远超均值 ${d.avg.toFixed(2)}kWh` })
    }
  }
  // 定额超标预警/告警：仅未闭环（待处理、处理中）的进入告警中心；已处理/已忽略不再打扰
  for (const a of listAlerts()) {
    if (a.status === 'resolved' || a.status === 'ignored') continue
    alerts.push({
      kind: 'quota', quota_alert_id: a.id,
      device: `${a.scope === 'room' ? '房间' : '设备'}·${a.target_name}`,
      level: a.level,
      text: `${a.period_label}定额${a.level === 'error' ? '超标' : '接近超标'}：已用 ${a.used_kwh.toFixed(2)}/${a.limit_kwh}kWh（${Math.round((a.used_kwh / a.limit_kwh) * 100)}%，${a.status_label}）`
    })
  }
  return alerts
}

// ===== 设备 =====
app.post('/api/device', (req, res) => {
  const { name, type_id, room_id } = req.body
  if (!name || !type_id || !room_id) return res.status(400).json({ error: 'missing' })
  const r = run('INSERT INTO devices (name,type_id,room_id) VALUES (?,?,?)', name, type_id, room_id)
  log(name, '新增设备', `房间 ${q1('SELECT name FROM rooms WHERE id=?', room_id).name}`)
  res.json({ ok: true, id: r.lastInsertRowid })
})
app.delete('/api/device/:id', (req, res) => {
  const d = q1('SELECT * FROM devices WHERE id=?', req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  // 引用该设备的场景动作将随外键 ON DELETE SET NULL 置空（失效引用）
  const affected = q1('SELECT COUNT(*) c FROM scene_actions WHERE device_id=?', d.id).c
  // 先结落未结用电段（历史记录保留），再删除设备
  closeDevice(d.id)
  run('DELETE FROM devices WHERE id=?', d.id)
  // 结段产生的新记录先计入定额，再评估（设备定额保留并标记已删除，历史告警按快照留存）
  evaluateAll()
  log(d.name, '删除设备', affected ? `${affected} 个场景动作失效` : '')
  res.json({ ok: true, affected_actions: affected })
})
// 切换开关
app.post('/api/device/:id/toggle', (req, res) => {
  const d = q1('SELECT * FROM devices WHERE id=?', req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  if (d.status === 'error') return res.status(409).json({ error: '设备异常，无法操作' })
  const on = d.power_on ? 0 : 1
  run('UPDATE devices SET power_on=? WHERE id=?', on, d.id)
  // 开关即分段边界：关闭结落本段用电，开启打开新段
  reconcileDevice(d.id)
  evaluateAll()
  log(d.name, on ? '开启' : '关闭')
  res.json({ ok: true, power_on: on })
})
// 更新设备字段
app.post('/api/device/:id/update', (req, res) => {
  const d = q1('SELECT * FROM devices WHERE id=?', req.params.id)
  if (!d) return res.status(404).json({ error: 'not found' })
  const { name, room_id, watts, power_on } = req.body
  if (room_id != null && !q1('SELECT id FROM rooms WHERE id=?', room_id))
    return res.status(400).json({ error: '房间不存在' })
  if (watts != null && (!Number.isFinite(+watts) || +watts < 0 || +watts > 10000))
    return res.status(400).json({ error: '功率需为 0-10000 的数字' })
  const nextName = (name ?? d.name).toString()
  const nextRoom = room_id ?? d.room_id
  const nextWatts = watts ?? d.watts
  const nextOn = power_on ?? d.power_on
  run('UPDATE devices SET name=?, room_id=?, watts=?, power_on=? WHERE id=?',
    nextName, nextRoom, nextWatts, nextOn, d.id)
  // 改名后同步场景动作里的名称快照（关联仍按 device_id，不受影响）
  if (nextName !== d.name) run('UPDATE scene_actions SET device_key=? WHERE device_id=?', nextName, d.id)
  // 功率/开关变化、改名、换房都构成分段边界：旧段按旧快照结落，新段用新快照记账
  if (nextName !== d.name || nextRoom !== d.room_id || nextWatts !== d.watts || nextOn !== d.power_on)
    reconcileDevice(d.id)
  const detail = []
  if (nextName !== d.name) detail.push(`改名「${d.name}」→「${nextName}」`)
  if (nextRoom !== d.room_id) detail.push(`换到 ${q1('SELECT name FROM rooms WHERE id=?', nextRoom).name}`)
  if (nextWatts !== d.watts) detail.push(`功率 ${d.watts}W→${nextWatts}W`)
  if (nextOn !== d.power_on) detail.push(nextOn ? '已开启' : '已关闭')
  log(nextName, '更新设备', detail.join('，'))
  res.json({ ok: true })
})

// ===== 场景 =====
app.post('/api/scene', (req, res) => {
  const { name, actions } = req.body
  const list = Array.isArray(actions) ? actions : []
  for (const a of list) {
    if (!q1('SELECT id FROM devices WHERE id=?', a.device_id))
      return res.status(400).json({ error: `动作引用了不存在的设备（ID ${a.device_id}）` })
  }
  const r = run('INSERT INTO scenes (name,desc,enabled) VALUES (?,?,1)', name || '新场景', '')
  const act = db.prepare('INSERT INTO scene_actions (scene_id,device_id,device_key,action,order_no) VALUES (?,?,?,?,?)')
  list.forEach((a, i) => {
    const d = q1('SELECT name FROM devices WHERE id=?', a.device_id)
    act.run(r.lastInsertRowid, a.device_id, d.name, a.action, i)
  })
  res.json({ ok: true, id: r.lastInsertRowid })
})
app.delete('/api/scene/:id', (req, res) => {
  const s = q1('SELECT * FROM scenes WHERE id=?', req.params.id)
  if (s) { run('DELETE FROM scenes WHERE id=?', s.id); run('DELETE FROM scene_actions WHERE scene_id=?', s.id) }
  res.json({ ok: true })
})
app.post('/api/scene/:id/toggle', (req, res) => {
  const s = q1('SELECT * FROM scenes WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  run('UPDATE scenes SET enabled=? WHERE id=?', s.enabled ? 0 : 1, s.id)
  res.json({ ok: true, enabled: s.enabled ? 0 : 1 })
})
// 触发场景：按 device_id 逐条执行，成功/失败如实记录并返回
app.post('/api/scene/:id/run', (req, res) => {
  const s = q1('SELECT * FROM scenes WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  if (!s.enabled) return res.status(409).json({ error: '场景已停用，无法执行' })
  const actions = q(`SELECT sa.*, d.id did, d.name dname, d.status dstatus,
                            (SELECT COUNT(*) FROM devices x WHERE x.name=sa.device_key) key_match_count
                     FROM scene_actions sa LEFT JOIN devices d ON d.id=sa.device_id
                     WHERE sa.scene_id=? ORDER BY sa.order_no, sa.id`, s.id)
  const executed = [], failed = []
  for (const a of actions) {
    const label = a.dname || a.device_key || `设备#${a.device_id ?? '?'}`
    if (!a.did) {
      // 未绑定动作一律跳过，绝不按名称猜测执行，避免误控同名设备
      const duplicate = a.key_match_count > 1
      const reason = duplicate ? '存在重名设备，待重新绑定' : '设备已删除'
      failed.push({ device: label, action: a.action, reason })
      log(label, `场景「${s.name}」执行失败`, `${a.action}（${reason}）`)
      continue
    }
    if (a.dstatus !== 'online') {
      failed.push({ device: a.dname, action: a.action, reason: '设备离线/异常' })
      log(a.dname, `场景「${s.name}」执行失败`, `${a.action}（设备离线/异常）`)
      continue
    }
    // 每个动作确定性地映射为开/关：关闭/关机/撤防→关，其余（开启/启动/布防/制冷/调光…）→开
    const on = /关|撤防/.test(a.action) ? 0 : 1
    run('UPDATE devices SET power_on=? WHERE id=?', on, a.did)
    reconcileDevice(a.did)
    log(a.dname, `场景「${s.name}」执行`, a.action)
    executed.push({ device: a.dname, action: a.action })
  }
  res.json({ ok: failed.length === 0, executed, failed })
})

// ===== 能耗定额与超标预警闭环 =====
// 额度配置（按房间/设备 × 日/周/月）；同一对象同一周期唯一
app.post('/api/quota', (req, res) => {
  try {
    const id = createQuota(req.body || {})
    log('定额', '新增定额',
      `${req.body.scope === 'room' ? '房间' : '设备'}定额已配置，周期 ${req.body.period}，额度 ${Number(req.body.limit_kwh)}kWh`)
    res.json({ ok: true, id })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/quota/:id/update', (req, res) => {
  try {
    const changes = updateQuota(Number(req.params.id), req.body || {})
    const q0 = q1('SELECT * FROM energy_quotas WHERE id=?', req.params.id)
    log('定额', '调整定额',
      `「${q0.target_name}」${changes.length ? changes.join('，') : '无变化'}` +
      `${req.body.reason ? `；备注：${req.body.reason}` : ''}`)
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.delete('/api/quota/:id', (req, res) => {
  try {
    const q0 = q1('SELECT * FROM energy_quotas WHERE id=?', req.params.id)
    deleteQuota(Number(req.params.id), req.body?.reason || '')
    if (q0) log('定额', '删除定额', `「${q0.target_name}」${q0.period} 定额已删除，未关闭告警自动解除`)
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
// 告警处理闭环：待处理 → 处理中 → 已处理/已忽略，可附处理备注
app.post('/api/quota-alert/:id/handle', (req, res) => {
  try {
    const { status, note } = req.body || {}
    const a0 = q1('SELECT * FROM quota_alerts WHERE id=?', req.params.id)
    if (!a0) return res.status(404).json({ error: '告警不存在' })
    const a = handleAlert(Number(req.params.id), { status, note })
    const label = { handling: '开始处理', resolved: '标记已处理', ignored: '忽略告警', open: a0.status === 'handling' ? '退回待处理' : '重新打开' }[status] || '更新状态'
    const periodLabel = { daily: '每日', weekly: '每周', monthly: '每月' }[a.period] || a.period
    log(`${a.scope === 'room' ? '房间' : '设备'}·${a.target_name}`, `定额告警·${label}`,
      `${periodLabel}用量 ${a.used_kwh.toFixed(2)}/${a.limit_kwh}kWh` + (note ? `；备注：${note}` : ''))
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
// 额度调整历史（不传 quota_id 时为全局最近 50 条）
app.get('/api/quota-adjustments', (req, res) => {
  res.json(getAdjustments(req.query.quota_id ? Number(req.query.quota_id) : null))
})

// ===== 日志 =====
app.get('/api/logs', (req, res) => {
  res.json(q('SELECT * FROM device_logs ORDER BY id DESC LIMIT 100'))
})

const PORT = 4120
app.listen(PORT, () => console.log(`[HOME] API running at http://localhost:${PORT}`))