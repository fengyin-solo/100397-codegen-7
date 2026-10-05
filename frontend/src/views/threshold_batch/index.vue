<template>
  <section class="page" data-module="threshold_batch">
    <header class="page-head">
      <div>
        <h2>预警阈值批量试算台</h2>
        <p class="page-desc">多选隐患点与监测类型生成候选参数，先试算影响面与版本冲突，再决定是否整批发布；过程可存草稿。</p>
      </div>
    </header>

    <div class="rule-box">
      <strong>冲突处理规则（本台约定）：</strong>
      <ol>
        <li>候选与现行「已生效」配置同隐患点+同监测类型 → 候选作为下一版本整批替换，旧版本归档版本台账；旧配置缺生效时间的，按本批设定时间回填。</li>
        <li>现行仅有「草稿」→ 草稿直接转正为 v1，不另占版本号。</li>
        <li>候选三级阈值与现行完全一致 → 判为重复，发布时跳过该条，不产生新版本。</li>
        <li>同一批次内同隐患点+同监测类型出现多条 → 判非法，整批不得发布。</li>
        <li>发布为整批事务：阈值配置、版本台账、雨量/倾斜判定台账一起成功或一起回退；批次发布后重复发布不生成第二套版本。</li>
        <li>判定口径：雨量按「日累计雨量」比对三级阈值，达注意级即触发预警；倾斜按「累积倾斜量」比对，达警戒级置「超限报警」，回落后恢复。</li>
      </ol>
    </div>

    <section class="panel">
      <h3>第一步：选择范围</h3>
      <div class="pick-row">
        <div class="pick-block">
          <span class="pick-label">隐患点（多选）</span>
          <label v-for="hazard in hazards" :key="hazard.code" class="check-item">
            <input type="checkbox" :value="hazard.code" v-model="selectedCodes" />
            {{ hazard.code }} · {{ hazard.name }}
          </label>
        </div>
        <div class="pick-block">
          <span class="pick-label">监测类型（多选）</span>
          <label v-for="type in monitorTypes" :key="type" class="check-item">
            <input type="checkbox" :value="type" v-model="selectedTypes" />
            {{ type }}
          </label>
        </div>
        <div class="pick-block">
          <label class="filter-item">
            <span>设定人</span>
            <input v-model="setter" />
          </label>
          <label class="filter-item">
            <span>生效时间（设定时间）</span>
            <input v-model="effectiveDate" type="date" />
          </label>
        </div>
      </div>
      <button class="btn primary" type="button" @click="generate">生成候选参数</button>
    </section>

    <section class="panel">
      <h3>第二步：候选参数（可编辑）</h3>
      <div class="batch-line">
        <label class="filter-item">
          <span>批次名称</span>
          <input v-model="batchName" placeholder="默认用批次号" />
        </label>
        <span v-if="currentBatchId" class="muted-text">当前草稿：{{ currentBatchId }}</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>隐患点</th>
              <th>监测类型</th>
              <th>注意级阈值</th>
              <th>警示级阈值</th>
              <th>警戒级阈值</th>
              <th>设定人</th>
              <th>生效时间</th>
              <th>试算结论</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="item.rowNo">
              <td>{{ item.rowNo }}</td>
              <td>
                {{ item.隐患点编号 }}
                <br />
                <span class="muted-text">{{ item.隐患点名称 }}</span>
              </td>
              <td>{{ item.监测类型 }}</td>
              <td><input class="cell-input" v-model="item.注意级阈值" /></td>
              <td><input class="cell-input" v-model="item.警示级阈值" /></td>
              <td><input class="cell-input" v-model="item.警戒级阈值" /></td>
              <td><input class="cell-input" v-model="item.设定人" /></td>
              <td><input class="cell-input" v-model="item.生效时间" type="date" /></td>
              <td class="trial-cell">
                <template v-if="trialOf(item.rowNo)">
                  <div v-if="trialOf(item.rowNo)!.issues.length">
                    <span class="tag danger">非法</span>
                    <p v-for="issue in trialOf(item.rowNo)!.issues" :key="issue.message" class="issue-text">
                      {{ issue.message }}
                    </p>
                  </div>
                  <div v-else>
                    <span :class="conflictClass(trialOf(item.rowNo)!.conflict)">
                      {{ trialOf(item.rowNo)!.conflict }}
                    </span>
                    <p class="muted-text">{{ trialOf(item.rowNo)!.conflictNote }}</p>
                    <p v-if="trialOf(item.rowNo)!.impacts.length" class="muted-text">
                      影响 {{ trialOf(item.rowNo)!.impacts.length }} 条判定记录
                    </p>
                  </div>
                </template>
                <span v-else class="muted-text">未试算</span>
              </td>
              <td>
                <button class="link" type="button" @click="removeItem(item.rowNo)">移除</button>
              </td>
            </tr>
            <tr v-if="!items.length">
              <td colspan="10" class="empty-state">尚未生成候选参数，请先在第一步选择范围</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="action-row">
        <button class="btn" type="button" @click="runTrial">试算</button>
        <button class="btn" type="button" @click="saveAsDraft">存草稿</button>
        <button class="btn primary" type="button" :disabled="!trial || !trial.passed" @click="publish">整批发布</button>
        <span v-if="trial && !trial.passed" class="error-text">存在非法参数，修正并重新试算后才能发布</span>
      </div>
    </section>

    <section v-if="trial" class="panel">
      <h3>试算结果</h3>
      <div class="stat-row">
        <article v-for="card in summaryCards" :key="card.label" class="stat-card">
          <span class="stat-label">{{ card.label }}</span>
          <strong class="stat-value">{{ card.value }}</strong>
        </article>
      </div>
      <div v-if="trial.issues.length" class="issue-box">
        <strong>非法条目（{{ trial.issues.length }} 处）：</strong>
        <p v-for="issue in trial.issues" :key="issue.label + issue.message" class="error-text">
          {{ issue.label }}：{{ issue.message }}
        </p>
      </div>
      <template v-if="trial.impacts.length">
        <h4>影响面明细（换基线后判定结论变化的记录）</h4>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>候选行</th>
                <th>台账</th>
                <th>记录编号</th>
                <th>隐患点</th>
                <th>观测值</th>
                <th>旧判定</th>
                <th>新判定</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="impact in trial.impacts" :key="impact.台账 + impact.记录编号">
                <td>第{{ impact.rowNo }}行</td>
                <td>{{ impact.台账 }}</td>
                <td>{{ impact.记录编号 }}</td>
                <td>{{ impact.隐患点编号 }}</td>
                <td>{{ impact.观测值 }}</td>
                <td>{{ impact.旧判定 }}</td>
                <td>{{ impact.新判定 }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-else class="muted-text">没有判定结论会变化的雨量/倾斜记录。</p>
      <p class="muted-text">关联预警通知（待发布/已发布）{{ trial.relatedAlarms }} 条：发布不改动其内容，仅提醒复核。</p>
    </section>

    <section class="panel">
      <h3>批次台账（草稿与已发布）</h3>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>批次号</th>
              <th>名称</th>
              <th>状态</th>
              <th>条目数</th>
              <th>内容哈希</th>
              <th>更新时间</th>
              <th>发布时间</th>
              <th>发布摘要</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in batches" :key="String(row.id)">
              <td>{{ row['批次号'] }}</td>
              <td>{{ row['批次名称'] }}</td>
              <td>{{ row.status }}</td>
              <td>{{ row['条目数'] }}</td>
              <td>{{ row['内容哈希'] }}</td>
              <td>{{ row['更新时间'] }}</td>
              <td>{{ row['发布时间'] || '—' }}</td>
              <td>{{ row['发布摘要'] || '—' }}</td>
              <td class="row-actions">
                <button class="link" type="button" @click="loadBatch(row)">载入</button>
                <button class="link" type="button" @click="publishSaved(row)">
                  {{ row.status === '已发布' ? '再发一次' : '发布' }}
                </button>
                <button v-if="row.status !== '已发布'" class="link" type="button" @click="removeBatch(row)">删除</button>
              </td>
            </tr>
            <tr v-if="!batches.length">
              <td colspan="9" class="empty-state">暂无批次，可先在上方生成候选参数并存草稿</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h3>阈值版本台账</h3>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>版本编号</th>
              <th>批次号</th>
              <th>阈值编号</th>
              <th>隐患点</th>
              <th>监测类型</th>
              <th>注意级</th>
              <th>警示级</th>
              <th>警戒级</th>
              <th>版本</th>
              <th>生效时间</th>
              <th>归档原因</th>
              <th>状态</th>
              <th>记录时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in versions" :key="String(row.id)">
              <td>{{ row['版本编号'] }}</td>
              <td>{{ row['批次号'] }}</td>
              <td>{{ row['阈值编号'] }}</td>
              <td>{{ row['隐患点编号'] }}</td>
              <td>{{ row['监测类型'] }}</td>
              <td>{{ row['注意级阈值'] }}</td>
              <td>{{ row['警示级阈值'] }}</td>
              <td>{{ row['警戒级阈值'] }}</td>
              <td>v{{ row['版本'] }}</td>
              <td>{{ row['生效时间'] || '—' }}</td>
              <td>{{ row['归档原因'] }}</td>
              <td>{{ row.status }}</td>
              <td>{{ row['记录时间'] }}</td>
            </tr>
            <tr v-if="!versions.length">
              <td colspan="13" class="empty-state">暂无版本记录，整批发布后在此留痕</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <footer class="page-foot">
      <span v-if="message" class="ok-text">{{ message }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import {
  MONITOR_TYPES,
  buildCandidates,
  deleteBatch,
  hazardOptions,
  listBatches,
  listVersions,
  loadDraft,
  publishBatch,
  saveDraft,
  trialRun,
} from '@/api/threshold-batch-service'
import type { CandidateItem, ItemTrial, MonitorType, TrialResult } from '@/api/threshold-batch-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const monitorTypes = MONITOR_TYPES

const hazards = ref(hazardOptions())
const selectedCodes = ref<string[]>([])
const selectedTypes = ref<MonitorType[]>(['雨量监测', '倾斜监测'])
const setter = ref(store.operator)
const effectiveDate = ref(new Date().toISOString().slice(0, 10))

const items = ref<CandidateItem[]>([])
const trial = ref<TrialResult | null>(null)
const batches = ref<EntryRow[]>([])
const versions = ref<EntryRow[]>([])
const currentBatchId = ref('')
const batchName = ref('')
const message = ref('')
const errorMessage = ref('')

const trialMap = computed(() => {
  const map = new Map<number, ItemTrial>()
  for (const entry of trial.value?.items ?? []) {
    map.set(entry.item.rowNo, entry)
  }
  return map
})

const summaryCards = computed(() => {
  if (!trial.value) return []
  const summary = trial.value.summary
  return [
    { label: '候选条目', value: summary.total },
    { label: '非法条目', value: summary.invalid },
    { label: '版本冲突(替换/覆盖)', value: summary.replacing },
    { label: '新增配置', value: summary.additions },
    { label: '与现行一致(跳过)', value: summary.skipped },
    { label: '雨量换基线', value: summary.rainRebased },
    { label: '倾斜换基线', value: summary.tiltRebased },
    { label: '关联预警通知', value: trial.value.relatedAlarms },
  ]
})

// 候选参数一旦被编辑，旧试算结论即过期，必须重新试算再发布。
watch(items, () => {
  trial.value = null
}, { deep: true })

function trialOf(rowNo: number): ItemTrial | undefined {
  return trialMap.value.get(rowNo)
}

function conflictClass(kind: string): string {
  const classes: Record<string, string> = {
    新增: 'tag info',
    覆盖草稿: 'tag warn',
    替换现行: 'tag warn',
    与现行一致: 'tag mute',
  }
  return classes[kind] ?? 'tag'
}

function generate() {
  message.value = ''
  errorMessage.value = ''
  if (!selectedCodes.value.length || !selectedTypes.value.length) {
    errorMessage.value = '请先至少选择一个隐患点和一种监测类型'
    return
  }
  items.value = buildCandidates(selectedCodes.value, selectedTypes.value, setter.value, effectiveDate.value)
  currentBatchId.value = ''
  trial.value = null
  message.value = `已生成 ${items.value.length} 条候选参数，可编辑后试算`
}

function removeItem(rowNo: number) {
  items.value = items.value.filter((item) => item.rowNo !== rowNo)
}

function runTrial() {
  message.value = ''
  errorMessage.value = ''
  if (!items.value.length) {
    errorMessage.value = '没有候选参数，请先生成'
    return
  }
  trial.value = trialRun(items.value)
  if (!trial.value.passed) {
    errorMessage.value = `试算发现 ${trial.value.issues.length} 处非法参数，请逐项修正后重新试算`
  }
}

function persistDraft(): string | null {
  const result = saveDraft({
    batchId: currentBatchId.value || undefined,
    name: batchName.value,
    items: items.value,
  })
  if (result.saved) {
    currentBatchId.value = result.batchId
    if (!batchName.value) batchName.value = result.batchId
  }
  refreshLedgers()
  return result.saved ? result.batchId : null
}

function saveAsDraft() {
  message.value = ''
  errorMessage.value = ''
  if (!items.value.length) {
    errorMessage.value = '没有候选参数，请先生成'
    return
  }
  const batchId = persistDraft()
  if (batchId) {
    message.value = `草稿 ${batchId} 已保存，可随时载入继续编辑`
  } else {
    errorMessage.value = '当前批次已发布，修改未保存；如需调整请重新生成候选另存新批次'
  }
}

function publish() {
  message.value = ''
  errorMessage.value = ''
  if (!trial.value || !trial.value.passed) {
    errorMessage.value = '请先试算且全部条目合法，再决定整批发布'
    return
  }
  const batchId = persistDraft()
  if (!batchId) {
    errorMessage.value = '当前批次已发布，不能作为草稿重复保存'
    return
  }
  const result = publishBatch(batchId)
  if (result.ok) {
    message.value = result.message
    // 发布后立即重算一次：同一批候选会变成「与现行一致」，直观看到幂等效果。
    trial.value = trialRun(items.value)
  } else {
    errorMessage.value = result.message
    trial.value = trialRun(items.value)
  }
  refreshLedgers()
}

function publishSaved(row: EntryRow) {
  message.value = ''
  errorMessage.value = ''
  const result = publishBatch(String(row['批次号']))
  if (result.ok) {
    message.value = result.message
  } else {
    errorMessage.value = result.message
  }
  refreshLedgers()
}

function loadBatch(row: EntryRow) {
  message.value = ''
  errorMessage.value = ''
  const batchId = String(row['批次号'])
  const draft = loadDraft(batchId)
  if (!draft) {
    errorMessage.value = `批次 ${batchId} 读取失败`
    return
  }
  items.value = draft.items
  trial.value = null
  if (draft.published) {
    currentBatchId.value = ''
    batchName.value = `${draft.name}(副本)`
    message.value = `已载入已发布批次 ${batchId} 的副本，再次发布会按现行配置判重`
  } else {
    currentBatchId.value = batchId
    batchName.value = draft.name
    message.value = `草稿 ${batchId} 已载入`
  }
}

function removeBatch(row: EntryRow) {
  const result = deleteBatch(String(row['批次号']))
  if (result.ok) {
    message.value = result.message
  } else {
    errorMessage.value = result.message
  }
  refreshLedgers()
}

function refreshLedgers() {
  batches.value = listBatches()
  versions.value = listVersions()
}

onMounted(refreshLedgers)
</script>

<style scoped>
.panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.panel h3 { margin: 0 0 10px; font-size: 14px; }
.panel h4 { margin: 10px 0 6px; font-size: 13px; }
.rule-box { background: #f0f6ff; border: 1px solid #c8dcff; border-radius: 8px; padding: 10px 14px; font-size: 12px; color: #334155; margin-bottom: 14px; }
.rule-box ol { margin: 6px 0 0; padding-left: 18px; }
.rule-box li { margin: 2px 0; }
.pick-row { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 10px; }
.pick-block { display: flex; flex-direction: column; gap: 4px; }
.pick-label { font-size: 12px; color: var(--muted); }
.check-item { font-size: 13px; display: flex; gap: 6px; align-items: center; }
.batch-line { display: flex; gap: 12px; align-items: flex-end; margin-bottom: 8px; }
.cell-input { width: 88px; }
.trial-cell { max-width: 280px; }
.tag { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 12px; background: #eef2f7; }
.tag.info { background: #e0ecff; color: #1d4ed8; }
.tag.warn { background: #fef3c7; color: #b45309; }
.tag.mute { background: #e5e7eb; color: #6b7280; }
.tag.danger { background: #fee2e2; color: #b42318; }
.issue-text { color: #b42318; font-size: 12px; margin: 2px 0; }
.issue-box { margin: 8px 0; }
.muted-text { color: var(--muted); font-size: 12px; margin: 2px 0; }
.ok-text { color: #067647; }
.action-row { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
.table-wrap { overflow-x: auto; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
