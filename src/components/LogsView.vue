<template>
  <div class="logs">
    <div class="toolbar">
      <button @click="reload">🔄 刷新</button>
      <span class="cnt">共 {{ store.logs.length }} 条</span>
    </div>
    <div class="timeline">
      <div v-for="(l,i) in store.logs" :key="l.id" class="entry">
        <span class="dot" :class="levelDot(l)"></span>
        <div class="body">
          <div class="line">
            <b>{{ l.device_name }}</b>
            <span class="act">{{ l.action }}</span>
            <span class="time">{{ l.time }}</span>
          </div>
          <div v-if="l.detail" class="detail">{{ l.detail }}</div>
        </div>
      </div>
      <div v-if="!store.logs.length" class="none">暂无日志</div>
    </div>
  </div>
</template>

<script setup>
import { useHomeStore } from '@/store/home'
const store = useHomeStore()
function reload() { store.load() }
function levelDot(l) {
  const t = l.action
  if (t.includes('关')) return 'off'
  if (t.includes('开')) return 'on'
  if (t.includes('场景')) return 'scene'
  if (t.includes('新增') || t.includes('删除')) return 'sys'
  return ''
}
</script>

<style scoped>
.logs{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;gap:10px;align-items:center;}
.toolbar button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;}
.cnt{color:#8ba2c8;font-size:12px;}
.timeline{border-left:2px solid #1a2a4a;padding-left:18px;display:flex;flex-direction:column;gap:14px;max-height:520px;overflow-y:auto;padding-right:8px;}
.entry{position:relative;}
.dot{position:absolute;left:-24px;top:4px;width:11px;height:11px;border-radius:50%;background:#546e7a;border:2px solid #0a1224;}
.dot.on{background:#66bb6a;}.dot.off{background:#ef5350;}.dot.scene{background:#ffd54f;}.dot.sys{background:#42a5f5;}
.body{background:#0f1b38;border:1px solid rgba(120,160,220,0.14);border-radius:10px;padding:10px 12px;}
.line{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.line b{color:#fff;font-size:13px;}
.act{background:#16263f;color:#90caf9;font-size:11px;padding:2px 8px;border-radius:5px;}
.time{margin-left:auto;color:#5b6f94;font-size:10px;}
.detail{color:#8ba2c8;font-size:11px;margin-top:4px;}
.none{color:#5b6f94;text-align:center;padding:30px;}
</style>