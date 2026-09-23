import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(path.join(__dirname, 'home.db'))

db.exec('PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',   -- online/offline/error
  battery INTEGER NOT NULL DEFAULT 100,    -- 0-100, 插座类可 100
  signal INTEGER NOT NULL DEFAULT 90,
  power_on INTEGER NOT NULL DEFAULT 0,     -- 0关 1开
  watts INTEGER NOT NULL DEFAULT 10
);
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS scene_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL,
  device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,  -- 稳定关联；设备删除后置空
  device_key TEXT NOT NULL DEFAULT '',  -- 设备名称快照，仅用于展示
  action TEXT NOT NULL,       -- 如 开启/关闭/设为暖光
  order_no INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS device_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL
);
-- 能耗由 energy.js 维护：energy_records（分段明细，按 device_id 归属、含完整起止时间）
-- + energy_segments（开启中设备的段首）。旧版 energy(设备名/房间/kwh/hour) 表自动迁移。
`)

// 迁移：旧版 scene_actions 只有 device_key（名称），重建为 device_id 稳定关联。
// 名称唯一命中的正常绑定；重名设备无法判定原引用究竟指向哪一台，一律置 NULL（保留名称快照，
// 待人工重新绑定）——绝不能擅自绑到最小 ID，否则触发场景会误控同名的其他设备。
// 名称已找不到（设备被删）的同样置 NULL，保留为失效引用。
function migrateSceneActions() {
  const cols = db.prepare('PRAGMA table_info(scene_actions)').all().map((c) => c.name)
  if (cols.includes('device_id')) return
  const rows = db.prepare('SELECT * FROM scene_actions').all()
  const findByName = db.prepare('SELECT id FROM devices WHERE name=? ORDER BY id')
  let dup = 0, lost = 0
  db.exec('BEGIN')
  try {
    db.exec(`CREATE TABLE scene_actions_migrated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id INTEGER NOT NULL,
      device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
      device_key TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      order_no INTEGER NOT NULL DEFAULT 0
    )`)
    const ins = db.prepare('INSERT INTO scene_actions_migrated (id,scene_id,device_id,device_key,action,order_no) VALUES (?,?,?,?,?,?)')
    for (const r of rows) {
      const m = findByName.all(r.device_key)
      let deviceId = null
      if (m.length === 1) {
        deviceId = m[0].id
      } else if (m.length > 1) {
        // 重名歧义：不猜、不绑，置 NULL 交由用户重新确认
        dup++
      } else {
        lost++
      }
      ins.run(r.id, r.scene_id, deviceId, r.device_key, r.action, r.order_no)
    }
    db.exec('DROP TABLE scene_actions')
    db.exec('ALTER TABLE scene_actions_migrated RENAME TO scene_actions')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  if (dup || lost) {
    db.prepare('INSERT INTO device_logs (device_name,action,detail,time) VALUES (?,?,?,?)')
      .run('系统', '迁移场景动作', `重名设备无法确定归属，未自动绑定 ${dup} 条（需手动重新绑定）；失效引用 ${lost} 条（原设备已删除）`, new Date().toLocaleString('zh-CN'))
  }
}
migrateSceneActions()

// 初始化（仅首次）
function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM rooms').get().c
  if (n > 0) return
  const ri = db.prepare('INSERT INTO rooms VALUES (?,?)')
  const rooms = ['客厅', '卧室', '厨房', '书房', '阳台']
  rooms.forEach((r, i) => ri.run(i + 1, r))

  const ti = db.prepare('INSERT INTO device_types VALUES (?,?,?)')
  const types = [
    [1, '智能灯', '💡'], [2, '空调', '❄️'], [3, '智能门锁', '🔐'],
    [4, '摄像头', '📷'], [5, '传感器', '📡'], [6, '智能插座', '🔌']
  ]
  types.forEach((t) => ti.run(...t))

  const di = db.prepare(`INSERT INTO devices (name,type_id,room_id,status,battery,signal,power_on,watts) VALUES (?,?,?,?,?,?,?,?)`)
  const devs = [
    ['客厅主灯', 1, 1, 'online', 100, 92, 1, 9],
    ['卧室吊灯', 1, 2, 'online', 100, 85, 0, 9],
    ['书房台灯', 1, 4, 'online', 100, 78, 1, 9],
    ['客厅空调', 2, 1, 'online', 100, 88, 1, 1500],
    ['卧室空调', 2, 2, 'online', 100, 90, 0, 1500],
    ['入户门锁', 3, 1, 'online', 62, 95, 1, 2],
    ['阳台门锁', 3, 5, 'online', 41, 70, 1, 2],
    ['客厅摄像头', 4, 1, 'online', 55, 82, 1, 6],
    ['玄关摄像头', 4, 1, 'online', 33, 65, 1, 6],
    ['客厅传感器', 5, 1, 'online', 81, 90, 1, 1],
    ['卧室传感器', 5, 2, 'online', 74, 86, 1, 1],
    ['厨房传感器', 5, 3, 'online', 68, 72, 1, 1],
    ['厨房插座', 6, 3, 'online', 100, 80, 1, 200],
    ['阳台插座', 6, 5, 'online', 100, 60, 0, 120],
    ['书房插座', 6, 4, 'error', 100, 45, 0, 0]
  ]
  devs.forEach((d) => di.run(...d))

  const si = db.prepare('INSERT INTO scenes (name,desc,enabled) VALUES (?,?,?)')
  const scId1 = si.run('回家模式', '进门后自动亮灯并打开客厅设备', 1).lastInsertRowid
  const scId2 = si.run('离家模式', '外出时关闭灯光与耗电设备', 1).lastInsertRowid
  const scId3 = si.run('晚安模式', '睡前关闭灯光、开启安防', 0).lastInsertRowid

  const ai = db.prepare('INSERT INTO scene_actions (scene_id,device_id,device_key,action,order_no) VALUES (?,?,?,?,?)')
  const devId = (name) => db.prepare('SELECT id FROM devices WHERE name=?').get(name)?.id ?? null
  ;[['客厅主灯', '开启'], ['客厅空调', '制冷26°C'], ['客厅传感器', '布防']].forEach((a, i) => ai.run(scId1, devId(a[0]), a[0], a[1], i))
  ;[['客厅主灯', '关闭'], ['卧室吊灯', '关闭'], ['书房台灯', '关闭'], ['客厅空调', '关机'], ['玄关摄像头', '开启']].forEach((a, i) => ai.run(scId2, devId(a[0]), a[0], a[1], i))
  ;[['卧室吊灯', '关闭'], ['客厅主灯', '关闭'], ['客厅摄像头', '布防'], ['卧室传感器', '布防']].forEach((a, i) => ai.run(scId3, devId(a[0]), a[0], a[1], i))

  // 能耗演示数据由 energy.js 首次启动时按分段模型生成（与设备功率/时长自洽）
}
seed()