<template>
  <div class="energy">
    <div class="kpis">
      <div class="kpi"><b>{{ store.energy.total.toFixed(2) }}</b><em>近24小时总能耗 (kWh)</em></div>
      <div class="kpi"><b>{{ onDevices }}</b><em>开启中设备</em></div>
      <div class="kpi"><b>{{ peakRoom }}</b><em>峰值房间</em></div>
      <div class="kpi"><b>{{ (store.totalWatts/1000).toFixed(2) }}</b><em>实时功率 (kW)</em></div>
    </div>

    <div class="card">
      <h4>🏠 按房间能耗分布 · 近24小时 (kWh)</h4>
      <div class="rows">
        <div v-for="r in store.energy.rooms" :key="r.room" class="erow">
          <span class="rl">{{ r.room }}</span>
          <div class="rt"><i :style="{width: pct(r.v)+'%'}"></i></div>
          <span class="rv">{{ r.v.toFixed(2) }}</span>
        </div>
        <div v-if="!store.energy.rooms.length" class="empty">暂无用电数据，开启设备后将按运行分段累计</div>
      </div>
    </div>

    <div class="card">
      <h4>🚿 设备用电排行 · 近24小时 (kWh)</h4>
      <table>
        <thead><tr><th>设备</th><th>房间</th><th>能耗</th><th>占比</th></tr></thead>
        <tbody>
          <tr v-for="d in topDevices" :key="(d.device_id ?? 'x') + '-' + d.device_name">
            <td>
              {{ d.device_name }}
              <i v-if="d.deleted" class="tag del">已删除</i>
              <i v-else-if="d.unbound" class="tag old">旧记录</i>
            </td>
            <td>{{ d.room || '—' }}</td>
            <td>{{ d.v.toFixed(2) }} kWh</td>
            <td><div class="tb"><i :style="{width: pct(d.v)+'%'}"></i></div></td>
          </tr>
        </tbody>
      </table>
      <div v-if="!store.energy.devices.length" class="empty">暂无用电数据</div>
      <p v-if="hasDeleted" class="sub">已删除设备的历史用电按其设备标识与当时房间快照保留，不并入其他同名设备。</p>
    </div>

    <p class="note">💡 节能建议：异常/离线设备不产生用电；长时间高功率运行会触发尖峰告警，可在场景中设置自动关闭。</p>

    <!-- 定额用量联动：分段用电持续聚合到各周期额度 -->
    <div class="card quota-link" @click="store.tab='quota'">
      <h4>📏 周期定额用量 <span class="more">配置/处理超标告警 →</span></h4>
      <div v-if="!store.quotas.length" class="empty">尚未配置能耗定额，可按房间/设备设置日、周、月用电额度，超标自动预警并闭环处理。</div>
      <div v-else class="qrows">
        <div v-for="q in dailyQuotas" :key="q.id" class="qrow" :class="rowClass(q)">
          <span class="ql">
            <i class="dot"></i>{{ q.target_name }}
            <em>{{ q.scope==='room'?'房间':'设备' }}·{{ q.period_label }}</em>
          </span>
          <div class="qt"><i :style="{width:Math.min(100,q.ratio)+'%'}"></i></div>
          <span class="qv">{{ q.used_kwh.toFixed(2) }}/{{ q.limit_kwh.toFixed(2) }} · {{ q.ratio }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useHomeStore } from '@/store/home'
const store = useHomeStore()

const onDevices = computed(() => store.onCount)
const peakRoom = computed(() => store.energy.rooms[0]?.room || '—')
const topDevices = computed(() => store.energy.devices.slice(0, 10))
const hasDeleted = computed(() => store.energy.devices.some((d) => d.deleted || d.unbound))
// 用量占比最高的 6 条定额优先展示，超标风险一目了然
const dailyQuotas = computed(() =>
  [...store.quotas].sort((a, b) => b.ratio - a.ratio).slice(0, 6))

// 仅未闭环告警或当前真实占比越线才标红/橙，已闭环历史告警不残留旧颜色
function rowClass(q) {
  const active = q.alert && (q.alert.status === 'open' || q.alert.status === 'handling')
  return {
    over: (active && q.alert.level === 'error') || (!active && q.ratio >= 100),
    near: (active && q.alert.level === 'warn') || (!active && q.ratio >= 80 && q.ratio < 100),
    off: !q.enabled
  }
}

function pct(v) {
  const max = Math.max(...store.energy.rooms.map((r) => r.v), 0.001)
  return Math.round((v / max) * 100)
}
</script>

<style scoped>
.energy{display:flex;flex-direction:column;gap:16px;}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.kpi{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;text-align:center;}
.kpi b{display:block;font-size:28px;color:#ffd54f;}
.kpi em{font-size:12px;color:#8ba2c8;font-style:normal;}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
h4{margin:0 0 12px;color:#fff;font-size:14px;}
.rows{display:flex;flex-direction:column;gap:8px;}
.erow{display:flex;align-items:center;gap:10px;font-size:12px;color:#8ba2c8;}
.rl{width:52px;}.rv{width:60px;text-align:right;color:#dbe4f3;font-weight:600;}
.rt{flex:1;height:12px;background:#0c1730;border-radius:6px;overflow:hidden;}
.rt i{display:block;height:100%;background:linear-gradient(90deg,#42a5f5,#ff7043);}
table{width:100%;border-collapse:collapse;font-size:13px;}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid rgba(120,160,220,0.1);}
th{color:#8ba2c8;font-weight:600;font-size:11px;}
td{color:#dbe4f3;}
.tb{height:8px;background:#0c1730;border-radius:4px;overflow:hidden;min-width:120px;}
.tb i{display:block;height:100%;background:#42a5f5;}
.tag{font-style:normal;font-size:10px;padding:1px 6px;border-radius:5px;margin-left:6px;vertical-align:middle;}
.tag.del{background:#4a2020;color:#ffab91;}
.tag.old{background:#3a3320;color:#ffe082;}
.sub{margin:10px 0 0;font-size:11px;color:#5b6f94;}
.empty{color:#5b6f94;text-align:center;padding:14px;font-size:12px;}
.note{color:#8ba2c8;font-size:12px;background:#14273f;border:1px dashed #ffd54f;color:#ffd54f;border-radius:10px;padding:12px 16px;}
.quota-link{cursor:pointer;}
.quota-link:hover{border-color:rgba(66,165,245,0.4);}
.more{float:right;font-size:11px;color:#64b5f6;font-weight:400;}
.qrows{display:flex;flex-direction:column;gap:9px;}
.qrow{display:flex;align-items:center;gap:10px;font-size:12px;color:#dbe4f3;}
.qrow.off{opacity:.5;}
.ql{width:170px;min-width:170px;}
.ql em{font-style:normal;color:#5b6f94;font-size:10px;margin-left:6px;}
.ql .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#42a5f5;margin-right:6px;}
.qrow.near .ql .dot{background:#ffa726;}
.qrow.over .ql .dot{background:#ef5350;}
.qv{width:190px;text-align:right;font-size:11px;color:#8ba2c8;}
.qrow.over .qv{color:#ef9a9a;font-weight:600;}
.qrow.near .qv{color:#ffcc80;font-weight:600;}
.qrow .qt i{display:block;height:100%;background:#42a5f5;}
.qrow.near .qt i{background:linear-gradient(90deg,#42a5f5,#ffa726);}
.qrow.over .qt i{background:linear-gradient(90deg,#ffa726,#ef5350);}
</style>
