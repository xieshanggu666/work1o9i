<template>
  <div class="quota">
    <!-- KPI -->
    <div class="kpis">
      <div class="kpi"><b>{{ store.quotas.length }}</b><em>已配置定额</em></div>
      <div class="kpi"><b class="amber">{{ openCount }}</b><em>待处理告警</em></div>
      <div class="kpi"><b class="orange">{{ warnCount }}</b><em>接近超标(≥80%)</em></div>
      <div class="kpi"><b class="red">{{ overCount }}</b><em>已超标(≥100%)</em></div>
    </div>

    <!-- 定额配置 -->
    <div class="card">
      <div class="card-head">
        <h4>📏 周期能耗定额 · 按房间 / 设备配置</h4>
        <button class="add" @click="openCreate">＋ 新建定额</button>
      </div>

      <!-- 新建/编辑表单 -->
      <form v-if="formShow" class="form" @submit.prevent="submit">
        <select v-model="form.scope" :disabled="!!form.id" @change="onScopeChange">
          <option value="room">按房间</option>
          <option value="device">按设备</option>
        </select>
        <select v-if="form.scope==='room'" v-model.number="form.room_id" required :disabled="!!form.id">
          <option :value="''" disabled>选择房间</option>
          <option v-for="r in store.rooms" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
        <select v-else v-model.number="form.device_id" required :disabled="!!form.id">
          <option :value="''" disabled>选择设备</option>
          <option v-for="d in store.devices" :key="d.id" :value="d.id">{{ d.type_icon }} {{ d.name }}（{{ d.room }}）</option>
        </select>
        <select v-model="form.period">
          <option value="daily">每日</option>
          <option value="weekly">每周（周一起）</option>
          <option value="monthly">每月</option>
        </select>
        <label class="limit-in">额度
          <input v-model.number="form.limit_kwh" type="number" min="0.1" step="0.1" required placeholder="kWh" />
          kWh
        </label>
        <input v-model="form.reason" class="reason" placeholder="调整/创建备注（可选，将留痕）" />
        <button type="submit" class="save">{{ form.id ? '保存调整' : '创建' }}</button>
        <button type="button" class="ghost" @click="formShow=false">取消</button>
      </form>

      <table v-if="store.quotas.length">
        <thead><tr>
          <th>对象</th><th>周期</th><th>额度</th><th style="width:26%">周期内用量</th>
          <th>状态</th><th>启用</th><th>操作</th>
        </tr></thead>
        <tbody>
          <tr v-for="q in store.quotas" :key="q.id" :class="{disabled:!q.enabled}">
            <td>
              <i class="tag" :class="q.scope">{{ q.scope==='room'?'房间':'设备' }}</i>
              {{ q.target_name }}
              <i v-if="q.device_deleted" class="tag del">设备已删除</i>
            </td>
            <td>{{ q.period_label }}</td>
            <td>{{ fmt(q.limit_kwh) }} kWh</td>
            <td>
              <div class="prog" :class="progClass(q)">
                <i :style="{width: barWidth(q)+'%'}"></i>
                <span>{{ q.used_kwh.toFixed(2) }} / {{ fmt(q.limit_kwh) }} kWh（{{ q.ratio }}%）</span>
              </div>
            </td>
            <td>
              <span v-if="!q.alert" class="ok">正常</span>
              <span v-else class="al" :class="q.alert.level">
                {{ q.alert.level==='error'?'🚨 已超标':'⚠️ 接近超标' }}
                <em>· {{ q.alert.status_label }}</em>
              </span>
            </td>
            <td>
              <label class="switch">
                <input type="checkbox" :checked="q.enabled" @change="store.toggleQuota(q)"/>
                <span></span>
              </label>
            </td>
            <td class="ops">
              <button @click="openEdit(q)">编辑</button>
              <button @click="showHistory(q.id)">历史</button>
              <button class="danger" @click="remove(q)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">尚未配置能耗定额，点击「新建定额」按房间或设备设置日/周/月用电额度。</div>
      <p class="sub">用量持续聚合「已结分段用电 + 运行中设备实时折算（功率×时长）」；达额度 80% 预警、100% 超标告警，同一周期只通知一次并可升级。</p>
    </div>

    <!-- 超标预警闭环 -->
    <div class="card">
      <div class="card-head">
        <h4>🚨 超标预警与处理闭环</h4>
        <div class="filters">
          <button v-for="f in alertFilters" :key="f.v" :class="{active: alertFilter===f.v}" @click="alertFilter=f.v">{{ f.t }}</button>
        </div>
      </div>
      <table v-if="filteredAlerts.length">
        <thead><tr>
          <th>级别</th><th>对象</th><th>周期</th><th>用量/额度</th><th>状态</th><th>处理备注</th><th>时间</th><th>操作</th>
        </tr></thead>
        <tbody>
          <tr v-for="a in filteredAlerts" :key="a.id">
            <td><span class="lv" :class="a.level">{{ a.level==='error'?'超标':'预警' }}</span></td>
            <td>{{ a.scope==='room'?'房间':'设备' }} · {{ a.target_name }}</td>
            <td>{{ a.period_label }}<br><span class="dim">{{ periodText(a) }}</span></td>
            <td>
              <b :class="a.level">{{ a.used_kwh.toFixed(2) }}</b> / {{ fmt(a.limit_kwh) }} kWh
              <span class="dim">（{{ Math.round(a.used_kwh/a.limit_kwh*100) }}%）</span>
            </td>
            <td><span class="st" :class="a.status">{{ a.status_label }}</span></td>
            <td class="note-cell">
              <span v-if="a.note">{{ a.note }}</span>
              <span v-else class="dim">—</span>
            </td>
            <td class="dim">{{ fmtTime(a.created_at) }}</td>
            <td class="ops">
              <template v-if="a.status==='open'">
                <button class="go" @click="act(a,'handling')">开始处理</button>
                <button class="ok-btn" @click="act(a,'resolved')">已处理</button>
                <button @click="act(a,'ignored')">忽略</button>
              </template>
              <template v-else-if="a.status==='handling'">
                <button class="ok-btn" @click="act(a,'resolved')">完成处理</button>
                <button @click="act(a,'open')">退回</button>
                <button @click="act(a,'ignored')">忽略</button>
              </template>
              <template v-else>
                <button @click="act(a,'open')">重新打开</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">当前筛选下没有告警。用量达到定额 80% / 100% 时将自动出现在这里。</div>
    </div>

    <!-- 调整历史 -->
    <div class="card">
      <div class="card-head">
        <h4>🗂 定额历史调整记录</h4>
        <span v-if="historyQuota" class="chip">
          仅显示：定额 #{{ historyQuota }}
          <button @click="historyQuota=null">✕ 清除</button>
        </span>
      </div>
      <table v-if="history.length">
        <thead><tr><th>时间</th><th>对象</th><th>操作</th><th>变化</th><th>备注</th></tr></thead>
        <tbody>
          <tr v-for="h in history" :key="h.id">
            <td class="dim">{{ fmtTime(h.created_at) }}</td>
            <td>
              {{ h.scope==='room'?'房间':h.scope==='device'?'设备':'—' }}
              {{ h.target_name ? '· ' + h.target_name : '' }}
              <span class="dim">#{{ h.quota_id }}</span>
            </td>
            <td><span class="act" :class="h.action">{{ actionText(h.action) }}</span></td>
            <td class="change">{{ changeText(h) }}</td>
            <td>{{ h.reason || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无调整记录。</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useHomeStore } from '@/store/home'
const store = useHomeStore()

const formShow = ref(false)
const form = ref(emptyForm())
const alertFilter = ref('active')
const alertFilters = [
  { v: 'active', t: '处理中/待处理' },
  { v: 'open', t: '待处理' },
  { v: 'resolved', t: '已处理' },
  { v: 'ignored', t: '已忽略' },
  { v: 'all', t: '全部' }
]
const history = ref([])
const historyQuota = ref(null)

function emptyForm() {
  return { id: null, scope: 'room', room_id: '', device_id: '', period: 'daily', limit_kwh: 1, reason: '', enabled: true }
}
function openCreate() { form.value = emptyForm(); formShow.value = true }
function onScopeChange() { form.value.room_id = ''; form.value.device_id = '' }
function openEdit(q) {
  form.value = {
    id: q.id, scope: q.scope,
    room_id: q.room_id || '', device_id: q.device_id || '',
    period: q.period, limit_kwh: q.limit_kwh, reason: '', enabled: q.enabled
  }
  formShow.value = true
}
async function submit() {
  const ok = await store.saveQuota(form.value)
  if (ok) { formShow.value = false; await loadHistory() }
}
async function remove(q) {
  if (confirm(`删除定额「${q.target_name} · ${q.period_label}」？\n未关闭的超标告警将自动解除，历史记录保留。`)) {
    await store.removeQuota(q.id)
    await loadHistory()
  }
}
async function act(a, status) {
  let note = a.note || ''
  if (status === 'resolved' || status === 'ignored') {
    const input = prompt(`处理备注（${status === 'resolved' ? '已处理' : '忽略'}，可留空）：`, note)
    if (input === null) return
    note = input
  }
  await store.handleQuotaAlert(a.id, { status, note })
}
async function showHistory(id) {
  historyQuota.value = id
  await loadHistory()
  document.querySelector('.quota')?.scrollIntoView({ behavior: 'smooth' })
}
async function loadHistory() {
  history.value = await store.fetchAdjustments(historyQuota.value)
}
onMounted(loadHistory)
// 每次 store 轮询刷新后同步全局历史（处于某额度过滤视图时不覆盖）
watch(() => store.quotaAlerts, () => { if (!historyQuota.value) loadHistory() })

const openCount = computed(() => store.pendingQuotaAlerts.length)
const warnCount = computed(() => store.pendingQuotaAlerts.filter((a) => a.level === 'warn').length)
const overCount = computed(() => store.pendingQuotaAlerts.filter((a) => a.level === 'error').length)
const filteredAlerts = computed(() => {
  const list = store.quotaAlerts
  if (alertFilter.value === 'all') return list
  if (alertFilter.value === 'active') return list.filter((a) => a.status === 'open' || a.status === 'handling')
  return list.filter((a) => a.status === alertFilter.value)
})

function progClass(q) {
  // 已闭环（已处理/已忽略/自动解除）的历史告警不再染色，进度条按当前真实占比着色
  const active = q.alert && (q.alert.status === 'open' || q.alert.status === 'handling')
  if (active && q.alert.level === 'error') return 'over'
  if (active && q.alert.level === 'warn') return 'near'
  if (q.ratio >= 100) return 'over'
  if (q.ratio >= 80) return 'near'
  if (q.ratio >= 50) return 'half'
  return ''
}
function barWidth(q) { return Math.min(100, Math.max(2, q.ratio)) }
function fmt(v) { return (+v).toFixed(2) }
function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function periodText(a) {
  return `${fmtTime(a.period_start).slice(5)} ~ ${fmtTime(a.period_end).slice(5)}`
}
function actionText(a) {
  return { create: '新建', update: '调整', enable: '启用', disable: '停用', delete: '删除' }[a] || a
}
function changeText(h) {
  const parts = []
  if (h.old_limit != null || h.new_limit != null) {
    parts.push(`${h.old_limit != null ? fmt(h.old_limit) : '—'} → ${h.new_limit != null ? fmt(h.new_limit) : '—'} kWh`)
  }
  if (h.old_period && h.new_period && h.old_period !== h.new_period) {
    const lb = { daily: '每日', weekly: '每周', monthly: '每月' }
    parts.push(`${lb[h.old_period]} → ${lb[h.new_period]}`)
  }
  return parts.join('；') || '—'
}
</script>

<style scoped>
.quota{display:flex;flex-direction:column;gap:16px;}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.kpi{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;text-align:center;}
.kpi b{display:block;font-size:28px;color:#ffd54f;}
.kpi b.amber{color:#ffb300;}.kpi b.orange{color:#ffa726;}.kpi b.red{color:#ef5350;}
.kpi em{font-size:12px;color:#8ba2c8;font-style:normal;}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
h4{margin:0;color:#fff;font-size:14px;}
.add{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;font-weight:600;cursor:pointer;border-radius:8px;padding:7px 14px;font-size:12px;}
.form{display:flex;gap:8px;flex-wrap:wrap;background:#0c1730;border:1px solid rgba(120,160,220,0.18);border-radius:10px;padding:12px;margin-bottom:12px;align-items:center;}
select,input,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.limit-in{display:flex;align-items:center;gap:6px;font-size:12px;color:#8ba2c8;}
.limit-in input{width:90px;}
.reason{flex:1;min-width:180px;}
.form .save{background:#2962ff;border:none;color:#fff;cursor:pointer;font-weight:600;}
.form .ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
table{width:100%;border-collapse:collapse;font-size:12px;}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid rgba(120,160,220,0.1);vertical-align:middle;}
th{color:#8ba2c8;font-weight:600;font-size:11px;}
td{color:#dbe4f3;}
tr.disabled{opacity:.55;}
.tag{font-style:normal;font-size:10px;padding:1px 6px;border-radius:5px;margin-right:6px;}
.tag.room{background:#163a2a;color:#80cbc4;}
.tag.device{background:#1b2f4a;color:#90caf9;}
.tag.del{background:#4a2020;color:#ffab91;margin-left:6px;}
.prog{position:relative;height:22px;background:#0c1730;border-radius:6px;overflow:hidden;display:flex;align-items:center;min-width:210px;}
.prog i{position:absolute;inset:0 auto 0 0;background:#42a5f5;opacity:.55;transition:width .4s;}
.prog span{position:relative;padding-left:8px;font-size:11px;color:#dbe4f3;white-space:nowrap;}
.prog.half i{background:#ffca28;}
.prog.near i{background:#ffa726;}
.prog.over i{background:#ef5350;}
.ok{color:#66bb6a;font-size:11px;}
.al{font-size:11px;font-weight:600;}
.al.warn{color:#ffa726;}.al.error{color:#ef5350;}
.al em{color:#8ba2c8;font-weight:400;font-style:normal;}
.switch{position:relative;width:40px;height:22px;display:inline-block;}
.switch input{opacity:0;width:0;height:0;}
.switch span{position:absolute;inset:0;background:#243357;border-radius:22px;transition:.2s;cursor:pointer;}
.switch span:before{content:'';position:absolute;width:18px;height:18px;left:2px;top:2px;background:#7b8db3;border-radius:50%;transition:.2s;}
.switch input:checked+span{background:#2962ff;}
.switch input:checked+span:before{transform:translateX(18px);background:#fff;}
.ops{white-space:nowrap;}
.ops button{padding:4px 9px;margin-right:4px;cursor:pointer;font-size:11px;}
.ops .danger{color:#ef5350;border-color:rgba(239,83,80,.4);}
.ops .go{color:#90caf9;border-color:rgba(66,165,245,.4);}
.ops .ok-btn{color:#a5d6a7;border-color:rgba(102,187,106,.4);}
.sub{margin:10px 0 0;font-size:11px;color:#5b6f94;}
.empty{color:#5b6f94;text-align:center;padding:14px;font-size:12px;}
.filters{display:flex;gap:6px;}
.filters button{cursor:pointer;font-size:11px;padding:5px 10px;}
.filters button.active{background:#2962ff;border-color:#2962ff;color:#fff;}
.lv{font-style:normal;font-size:10px;padding:2px 8px;border-radius:6px;font-weight:600;}
.lv.warn{background:#4e3410;color:#ffcc80;}
.lv.error{background:#4a1818;color:#ff8a80;}
.st{font-style:normal;font-size:10px;padding:2px 8px;border-radius:6px;}
.st.open{background:#4a1818;color:#ff8a80;}
.st.handling{background:#13315c;color:#90caf9;}
.st.resolved{background:#1b3a1f;color:#a5d6a7;}
.st.ignored{background:#263238;color:#90a4ae;}
.dim{color:#5b6f94;font-size:11px;}
.note-cell{max-width:180px;font-size:11px;color:#8ba2c8;}
.chip{font-size:11px;color:#90caf9;background:#13315c;border-radius:20px;padding:3px 10px;}
.chip button{background:none;border:none;color:#90caf9;cursor:pointer;padding:0 0 0 6px;}
.act{font-style:normal;font-size:10px;padding:2px 8px;border-radius:6px;}
.act.create{background:#1b3a1f;color:#a5d6a7;}
.act.update{background:#13315c;color:#90caf9;}
.act.enable{background:#1b3a1f;color:#a5d6a7;}
.act.disable{background:#3a2f12;color:#ffd54f;}
.act.delete{background:#4a1818;color:#ff8a80;}
.change{font-size:11px;color:#8ba2c8;}
</style>
