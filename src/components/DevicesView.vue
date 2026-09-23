<template>
  <div class="devs">
    <div class="toolbar">
      <div class="filter">
        <select v-model="fRoom"><option :value="0">全部房间</option><option v-for="r in store.rooms" :key="r.id" :value="r.id">{{ r.name }}</option></select>
        <select v-model="fType"><option :value="0">全部类型</option><option v-for="t in store.types" :key="t.id" :value="t.id">{{ t.name }}</option></select>
        <select v-model="fStatus"><option value="">全部状态</option><option value="online">在线</option><option value="error">异常</option></select>
      </div>
      <button class="add" @click="showAdd = !showAdd">＋ 添加设备</button>
    </div>

    <form v-if="showAdd" class="add-form" @submit.prevent="submit">
      <input v-model="form.name" placeholder="设备名称，如 儿童房夜灯" required />
      <select v-model="form.type_id" required><option disabled value="">设备类型</option><option v-for="t in store.types" :key="t.id" :value="t.id">{{ t.icon }} {{ t.name }}</option></select>
      <select v-model="form.room_id" required><option disabled value="">所属房间</option><option v-for="r in store.rooms" :key="r.id" :value="r.id">{{ r.name }}</option></select>
      <button type="submit">保存</button>
      <button type="button" class="ghost" @click="showAdd=false">取消</button>
    </form>

    <div class="list">
      <div v-for="d in filtered" :key="d.id" class="dev" :class="{off:!d.power_on, err:d.status==='error'}">
        <div class="d-head">
          <span class="d-icon">{{ d.type_icon }}</span>
          <div class="d-info">
            <b>{{ d.name }}</b>
            <span class="room">{{ d.room }} · {{ d.type_name }}</span>
          </div>
          <span class="badge" :class="d.status">{{ d.status==='online'?'在线':d.status==='error'?'异常':'离线' }}</span>
          <label class="switch">
            <input type="checkbox" :checked="!!d.power_on" @change="store.toggleDevice(d.id)" :disabled="d.status==='error'"/>
            <span></span>
          </label>
          <button class="mini-del" @click="remove(d)">✕</button>
        </div>
        <div class="d-meta">
          <span>🔋{{ d.battery }}%</span>
          <span>📶{{ d.signal }}</span>
          <span>⚡{{ d.watts }}W</span>
          <input class="inline-edit" :value="d.watts" type="number" @change="store.updateDevice(d.id,{watts:+$event.target.value})" title="编辑功率(W)"/>
        </div>
        <div class="meters">
          <div class="m"><i class="batt" :style="{width:Math.min(100,d.battery)+'%'}"></i></div>
          <div class="m"><i class="sig" :style="{width:Math.min(100,d.signal)+'%'}"></i></div>
        </div>
      </div>
      <div v-if="!filtered.length" class="none">没有匹配的设备</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useHomeStore } from '@/store/home'
const store = useHomeStore()
const fRoom = ref(0), fType = ref(0), fStatus = ref('')
const showAdd = ref(false)
const form = ref({ name: '', type_id: '', room_id: '' })

const filtered = computed(() => store.devices.filter((d) =>
  (!fRoom.value || d.room_id === fRoom.value) &&
  (!fType.value || d.type_id === fType.value) &&
  (!fStatus.value || d.status === fStatus.value)
))

function submit() {
  store.addDevice({ name: form.value.name, type_id: Number(form.value.type_id), room_id: Number(form.value.room_id) })
  form.value = { name: '', type_id: '', room_id: '' }
  showAdd.value = false
}
async function remove(d) {
  if (confirm(`删除设备「${d.name}」？`)) await store.removeDevice(d.id)
}
</script>

<style scoped>
.devs{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.filter{display:flex;gap:8px;}
select,input,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.add{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;font-weight:600;cursor:pointer;}
.add-form{display:flex;gap:8px;flex-wrap:wrap;background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:12px;}
.add-form button{background:#2962ff;border:none;color:#fff;cursor:pointer;font-weight:600;}
.add-form button.ghost{background:#16263f;color:#8ba2c8;}
.list{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;}
.dev{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:12px;}
.dev.err{border-color:rgba(239,83,80,0.5);}
.dev.off{opacity:.75;}
.d-head{display:flex;align-items:center;gap:8px;}
.d-icon{font-size:22px;}
.d-info{flex:1;min-width:0;}
.d-info b{display:block;color:#fff;font-size:14px;}
.room{font-size:11px;color:#8ba2c8;}
.badge{font-size:10px;padding:2px 8px;border-radius:6px;}
.badge.online{background:#1b5e20;color:#a5d6a7;}.badge.error{background:#b71c1c;color:#ffcdd2;}
.switch{position:relative;width:40px;height:22px;}
.switch input{opacity:0;width:0;height:0;}
.switch span{position:absolute;inset:0;background:#243357;border-radius:22px;transition:.2s;cursor:pointer;}
.switch span:before{content:'';position:absolute;width:18px;height:18px;left:2px;top:2px;background:#7b8db3;border-radius:50%;transition:.2s;}
.switch input:checked+span{background:#2962ff;}
.switch input:checked+span:before{transform:translateX(18px);background:#fff;}
.mini-del{background:none;border:none;color:#ef5350;font-size:14px;cursor:pointer;}
.d-meta{display:flex;gap:12px;margin-top:8px;font-size:11px;color:#8ba2c8;}
.inline-edit{width:60px;padding:3px 6px;font-size:11px;margin-left:auto;}
.meters{margin-top:6px;}
.m{height:5px;background:#0c1730;border-radius:3px;margin-top:3px;overflow:hidden;}
.m i{display:block;height:100%;}
.batt{background:#66bb6a;}.sig{background:#42a5f5;}
.none{color:#5b6f94;text-align:center;padding:30px;}
</style>