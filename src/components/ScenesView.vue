<template>
  <div class="scenes">
    <div class="toolbar">
      <button class="add" @click="showBuilder = !showBuilder">＋ 新建场景</button>
    </div>

    <!-- 场景构建器 -->
    <form v-if="showBuilder" class="builder" @submit.prevent="create">
      <h4>🛠️ 场景编排</h4>
      <input v-model="sceneForm.name" placeholder="场景名称，如 观影模式" required />
      <p class="hint">为场景添加「设备 → 动作」步骤：</p>
      <div class="step" v-for="(s,i) in sceneForm.actions" :key="i">
        <select v-model="s.device_id">
          <option v-for="d in store.devices" :key="d.id" :value="d.id">{{ d.type_icon }} {{ d.name }}</option>
        </select>
        <select v-model="s.action"><option>开启</option><option>关闭</option><option>调节亮度</option><option>布防</option><option>启动</option></select>
        <button type="button" class="rm" @click="sceneForm.actions.splice(i,1)">✕</button>
      </div>
      <button type="button" class="ghost" @click="sceneForm.actions.push({device_id:store.devices[0]?.id??null,action:'开启'})">＋ 添加步骤</button>
      <div class="btns">
        <button type="submit" class="save">保存场景</button>
        <button type="button" class="ghost" @click="showBuilder=false">取消</button>
      </div>
    </form>

    <!-- 最近一次执行的失败明细 -->
    <div v-if="lastResult" class="fail-panel">
      <b>⚠️ 场景「{{ lastResult.scene }}」有 {{ lastResult.failed.length }} 个动作未执行：</b>
      <div v-for="(f,i) in lastResult.failed" :key="i" class="fail-item">
        {{ f.device }} · {{ f.action }} — {{ f.reason }}
      </div>
      <button class="ghost" @click="lastResult=null">知道了</button>
    </div>

    <!-- 场景列表 -->
    <div class="list">
      <div v-for="s in store.scenes" :key="s.id" class="scene" :class="{off:!s.enabled}">
        <div class="s-head">
          <div class="s-info">
            <b>{{ s.name }}</b>
            <span class="desc">{{ s.desc || (s.action_count + ' 个动作') }}</span>
          </div>
          <span class="badge" :class="s.enabled?'on':'off'">{{ s.enabled?'已启用':'已停用' }}</span>
        </div>
        <div class="actions">
          <div v-for="a in s.actions" :key="a.id" class="act-chip" :class="{invalid:!a.device_name}">
            <span class="k">{{ a.device_name || a.device_key || '未知设备' }}<em v-if="!a.device_name">{{ a.unresolved === 'duplicate' ? '重名·待重新绑定' : '已删除' }}</em></span>
            <span class="v">{{ a.action }}</span>
          </div>
          <span v-if="!s.actions.length" class="noact">无动作</span>
        </div>
        <div class="btns">
          <button class="run" :disabled="!s.enabled" @click="run(s)">▶ 触发</button>
          <button class="ghost" @click="store.toggleScene(s.id)">{{ s.enabled?'停用':'启用' }}</button>
          <button class="ghost del" @click="remove(s)">删除</button>
        </div>
      </div>
      <div v-if="!store.scenes.length" class="none">暂无场景</div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useHomeStore } from '@/store/home'
const store = useHomeStore()
const showBuilder = ref(false)
const sceneForm = ref({ name: '', actions: [] })
const lastResult = ref(null)

function create() {
  const actions = sceneForm.value.actions.filter((a) => a.device_id != null)
  store.addScene({ name: sceneForm.value.name, actions })
  sceneForm.value = { name: '', actions: [] }
  showBuilder.value = false
}
async function run(s) {
  const r = await store.runScene(s.id)
  if (r?.failed?.length) lastResult.value = { scene: s.name, failed: r.failed }
  else lastResult.value = null
}
async function remove(s) {
  if (confirm(`删除场景「${s.name}」？`)) await store.deleteScene(s.id)
}
</script>

<style scoped>
.scenes{display:flex;flex-direction:column;gap:12px;}
.toolbar button{font-family:inherit;background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;}
.builder{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;}
.builder h4{margin:0;color:#fff;}
input,select,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.hint{color:#8ba2c8;font-size:12px;margin:0;}
.step{display:flex;gap:8px;}
.rm{background:none;border:none;color:#ef5350;cursor:pointer;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.btns{display:flex;gap:8px;margin-top:6px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.list{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;}
.scene{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;}
.scene.off{opacity:.7;}
.s-head{display:flex;justify-content:space-between;align-items:center;}
.s-info b{color:#fff;font-size:15px;}
.desc{display:block;font-size:11px;color:#8ba2c8;}
.badge{font-size:10px;padding:2px 8px;border-radius:6px;}
.badge.on{background:#1b5e20;color:#a5d6a7;}.badge.off{background:#37474f;color:#90a4ae;}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;}
.act-chip{background:#16263f;border:1px solid rgba(120,160,220,0.12);border-radius:7px;font-size:11px;overflow:hidden;display:flex;}
.act-chip .k{padding:4px 6px;color:#90caf9;border-right:1px solid rgba(120,160,220,0.15);}
.act-chip .k em{font-style:normal;color:#ef5350;font-size:10px;margin-left:4px;}
.act-chip.invalid{border-color:rgba(239,83,80,0.45);}
.act-chip .v{padding:4px 8px;color:#dbe4f3;}
.fail-panel{background:#2a1518;border:1px solid rgba(239,83,80,0.4);border-radius:12px;padding:12px 14px;font-size:12px;color:#ffcdd2;display:flex;flex-direction:column;gap:6px;}
.fail-panel .fail-item{color:#ef9a9a;}
.fail-panel .ghost{align-self:flex-start;}
.noact{color:#5b6f94;font-size:12px;padding:4px 0;}
.run{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;font-weight:600;cursor:pointer;}
.run:disabled{background:#243357;color:#6f84ab;cursor:not-allowed;}
.ghost.del{color:#ef5350;}
.none{color:#5b6f94;text-align:center;padding:30px;}
</style>