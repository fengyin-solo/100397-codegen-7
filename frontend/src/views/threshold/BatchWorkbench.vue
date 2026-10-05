<template>
  <section class="page" data-module="threshold-batch">
    <header class="page-head">
      <div>
        <h2>预警阈值批量试算台</h2>
        <p class="page-desc">
          多选隐患点和监测类型，先算影响面与版本冲突，再决定是否整批发布；过程可存草稿。
          发布后雨量、倾斜监测台账同步换判定基线，整批事务一起成功或一起回退。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" to="/threshold">返回阈值台账</RouterLink>
      </div>
    </header>

    <ol class="step-bar">
      <li :class="{ active: step >= 1 }">1 多选隐患点 × 监测类型，录候选参数</li>
      <li :class="{ active: step >= 2 }">2 试算影响面与版本冲突</li>
      <li :class="{ active: step >= 3 }">3 确认后整批发布（可存草稿）</li>
    </ol>

    <div class="pick-bar">
      <label class="pick-item">
        <span>隐患点（可多选）</span>
        <span class="check-group">
          <label v-for="hazard in hazards" :key="hazard.code" class="check-pill">
            <input type="checkbox" :value="hazard.code" v-model="selectedHazards" />
            {{ hazard.code }} {{ hazard.name }}
          </label>
        </span>
      </label>
      <label class="pick-item">
        <span>监测类型（可多选）</span>
        <span class="check-group">
          <label v-for="chain in chains" :key="chain.kind" class="check-pill">
            <input type="checkbox" :value="chain.kind" v-model="selectedTypes" />
            {{ chain.kind }}（{{ chain.valueLabel }}/{{ chain.valueUnit }}）
          </label>
        </span>
      </label>
      <div class="pick-ops">
        <button class="btn primary" type="button" :disabled="!hasSelection" @click="addCandidates">
          生成候选条目
        </button>
        <button class="btn" type="button" :disabled="!rows.length" @click="resetRows">清空条目</button>
      </div>
    </div>

    <div class="draft-bar">
      <input v-model="setter" placeholder="设定人" />
      <input v-model="effectiveTime" placeholder="生效时间，如 2026-10-06 00:00" />
      <button class="btn" type="button" :disabled="!rows.length" @click="onSaveDraft">存草稿</button>
      <button class="btn ghost" type="button" @click="showDrafts = !showDrafts">
        {{ showDrafts ? '收起草稿/批次' : `查看草稿/批次（${batchList.length}）` }}
      </button>
      <span v-if="currentBatch" class="batch-tag">
        当前批次：{{ currentBatch.batchNo }}（{{ currentBatch.status }}）
      </span>
    </div>

    <div v-if="showDrafts" class="draft-list card">
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>状态</th>
            <th>条目</th>
            <th>创建时间</th>
            <th>最近更新</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batchList" :key="batch.batchNo">
            <td>{{ batch.batchNo }}</td>
            <td>{{ batch.status }}</td>
            <td>{{ batch.candidates.length }}</td>
            <td>{{ formatTime(batch.createdAt) }}</td>
            <td>{{ formatTime(batch.updatedAt) }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="loadBatch(batch)">续编辑</button>
              <button
                v-if="batch.status === '草稿'"
                class="link danger"
                type="button"
                @click="discardBatch(batch)"
              >
                丢弃
              </button>
            </td>
          </tr>
          <tr v-if="!batchList.length">
            <td colspan="6" class="empty-state">还没有草稿或已发布批次</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3 class="card-title">候选参数</h3>
      <table class="data-table candidate-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>隐患点编号</th>
            <th>监测类型</th>
            <th>注意级阈值</th>
            <th>警示级阈值</th>
            <th>警戒级阈值</th>
            <th>现行基线</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in rows" :key="row.key">
            <td>{{ index + 1 }}</td>
            <td>{{ row.hazardCode }}</td>
            <td>{{ row.monitorType }}</td>
            <td><input v-model="row.notice" :aria-label="`注意级-${row.key}`" /></td>
            <td><input v-model="row.warning" :aria-label="`警示级-${row.key}`" /></td>
            <td><input v-model="row.alert" :aria-label="`警戒级-${row.key}`" /></td>
            <td class="baseline-cell">
              <template v-if="row.current">
                v{{ row.current.version }}：{{ row.current.levels['注意级'] }} /
                {{ row.current.levels['警示级'] }} / {{ row.current.levels['警戒级'] }}
                <span class="muted">（{{ row.current.effectiveTime || '生效时间按设定时间回填' }}）</span>
              </template>
              <span v-else class="muted">无现行基线</span>
            </td>
            <td><button class="link danger" type="button" @click="removeRow(index)">移除</button></td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="8" class="empty-state">先勾选隐患点和监测类型，再生成候选条目</td>
          </tr>
        </tbody>
      </table>
      <div class="trial-ops">
        <button class="btn primary" type="button" :disabled="!rows.length" @click="onTrial">
          试算（影响面 + 版本冲突）
        </button>
        <button class="btn primary" type="button" :disabled="!rows.length" @click="onPublish">
          整批发布
        </button>
        <span v-if="confirmLevel" class="warn-text">
          存在需确认的冲突项，已按既定处理规则勾选放行后才能发布。
        </span>
      </div>
    </div>

    <div v-if="trial" class="card">
      <h3 class="card-title">试算结果</h3>

      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">候选条目</span>
          <strong class="stat-value">{{ trial.candidates.length }} / {{ rows.length }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">覆盖隐患点</span>
          <strong class="stat-value">{{ trial.impact.affectedHazards }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">影响观测记录</span>
          <strong class="stat-value">{{ trial.impact.affectedRows }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">等级变化</span>
          <strong class="stat-value">{{ trial.impact.changedRows }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">取数缺测/不可读</span>
          <strong class="stat-value">{{ trial.impact.unreadableRows }}</strong>
        </article>
      </div>

      <section v-if="trial.issues.length" class="result-section">
        <h4 class="result-head error-text">非法参数（{{ trial.issues.length }}）——任一非法整批不可发布</h4>
        <ul class="issue-list">
          <li v-for="(issue, i) in trial.issues" :key="i" class="issue-item error">
            第 {{ issue.index + 1 }} 条（{{ issue.hazardCode || '?' }} / {{ issue.monitorType || '?' }}）
            【{{ issue.field }}】{{ issue.message }}
          </li>
        </ul>
      </section>

      <section v-if="trial.conflicts.length" class="result-section">
        <h4 class="result-head">版本冲突（{{ trial.conflicts.length }}）与处理规则</h4>
        <ul class="issue-list">
          <li
            v-for="(conflict, i) in trial.conflicts"
            :key="i"
            class="issue-item"
            :class="conflict.severity"
          >
            <p>
              <span class="conflict-kind">{{ conflictLabel[conflict.kind] }}</span>
              {{ conflict.hazardCode }} / {{ conflict.monitorType }}：{{ conflict.detail }}
            </p>
            <p class="rule-text">处理规则：{{ conflict.rule }}</p>
            <label v-if="conflict.severity === 'confirm'" class="ack-line">
              <input type="checkbox" :checked="acknowledged[conflictKey(conflict)]"
                @change="toggleAck(conflict)" />
              我已知晓并按此规则处理
            </label>
            <p v-if="conflict.severity === 'block'" class="block-text">阻断项：处理前无法发布</p>
          </li>
        </ul>
      </section>

      <section v-for="group in impactGroups" :key="group.title" class="result-section">
        <h4 class="result-head">{{ group.title }}（{{ group.rows.length }} 条）</h4>
        <table class="data-table impact-table">
          <thead>
            <tr>
              <th>记录编号</th>
              <th>隐患点</th>
              <th>{{ group.valueLabel }}（{{ group.unit }}）</th>
              <th>现判定</th>
              <th>试算后</th>
              <th>变化</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in group.rows" :key="`${item.moduleKey}-${item.rowId}`"
              :class="{ changed: item.changed }">
              <td>{{ item.recordCode }}</td>
              <td>{{ item.hazardCode }}</td>
              <td>{{ item.numericValue === null ? '不可读：' + item.rawValue : item.numericValue }}</td>
              <td>{{ item.beforeLevel ?? '未达注意级' }}</td>
              <td>{{ item.afterLevel ?? '未达注意级' }}</td>
              <td>{{ item.changed ? '重判 ⇄' : '不变' }}</td>
            </tr>
            <tr v-if="!group.rows.length">
              <td colspan="6" class="empty-state">该取数链暂无受影响记录</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p v-if="trial.canPublish" class="ok-text">
        校验通过、无阻断冲突，可以整批发布；发布将在同一事务内更新阈值版本并同步雨量/倾斜台账基线。
      </p>
      <p v-else class="error-text">当前不可发布：请修正非法参数或阻断性冲突后重新试算。</p>
    </div>

    <p v-if="message" class="result-banner" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listRows } from '@/data/local-store'
import { previewBatch, publishBatch, saveDraft } from '@/data/batch/publish'
import { getBatch, listBatches, removeBatch } from '@/data/batch/batch-store'
import { readBaseline } from '@/data/batch/baseline'
import {
  KIND_CHAINS,
  type BatchCandidateInput,
  type Conflict,
  type ConflictKind,
  type TrialResult,
} from '@/data/batch/types'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const chains = KIND_CHAINS

const hazards = ref<{ code: string; name: string }[]>([])
const selectedHazards = ref<string[]>([])
const selectedTypes = ref<string[]>([])

type CandidateRow = BatchCandidateInput & {
  key: string
  current: ReturnType<typeof readBaseline>
}

const rows = ref<CandidateRow[]>([])
const setter = ref(session.operator)
const effectiveTime = ref('2026-10-06 00:00')

const trial = ref<TrialResult | null>(null)
const message = ref('')
const messageOk = ref(false)
const step = ref(1)
const showDrafts = ref(false)
const batchList = ref(listBatches())
const currentBatchNo = ref<string | null>(null)
const acknowledged = ref<Record<string, boolean>>({})

const currentBatch = computed(() =>
  currentBatchNo.value ? getBatch(currentBatchNo.value) : null,
)

const hasSelection = computed(() => selectedHazards.value.length > 0 && selectedTypes.value.length > 0)

const conflictLabel: Record<ConflictKind, string> = {
  duplicate: '【批次内重复】',
  baselineChanged: '【基线漂移】',
  draftExists: '【已有草稿】',
  currentObsolete: '【现行已废止】',
  noBaseline: '【首次建基线】',
}

const impactGroups = computed(() => {
  if (!trial.value) {
    return []
  }
  return [
    { title: '雨量监测取数链影响面', rows: trial.value.impact.rainRows, valueLabel: '小时最大雨强', unit: 'mm/h' },
    { title: '倾斜监测取数链影响面', rows: trial.value.impact.tiltRows, valueLabel: '倾斜角度', unit: '°' },
  ]
})

const confirmLevel = computed(() =>
  trial.value?.conflicts.some((item) => item.severity === 'confirm') ?? false,
)

onMounted(() => {
  const codes = new Set<string>()
  for (const row of listRows('hazard')) {
    const code = String(row['隐患点编号'] ?? '').trim()
    if (code && !codes.has(code)) {
      codes.add(code)
      hazards.value.push({ code, name: String(row['隐患点名称'] ?? '') })
    }
  }
})

function makeRow(hazardCode: string, monitorType: string): CandidateRow {
  const current = readBaseline({ hazardCode, monitorType })
  return {
    key: `${hazardCode}@@${monitorType}`,
    hazardCode,
    monitorType,
    notice: current ? String(current.levels['注意级']) : '',
    warning: current ? String(current.levels['警示级']) : '',
    alert: current ? String(current.levels['警戒级']) : '',
    effectiveTime: effectiveTime.value,
    setter: setter.value,
    current,
  }
}

// 生成候选条目：同一隐患点+监测类型不重复添加，沿用现行阈值做预填。
function addCandidates() {
  const existing = new Set(rows.value.map((row) => row.key))
  for (const hazardCode of selectedHazards.value) {
    for (const monitorType of selectedTypes.value) {
      const key = `${hazardCode}@@${monitorType}`
      if (!existing.has(key)) {
        rows.value.push(makeRow(hazardCode, monitorType))
      }
    }
  }
  step.value = Math.max(step.value, 1)
}

function removeRow(index: number) {
  rows.value.splice(index, 1)
  trial.value = null
}

function resetRows() {
  rows.value = []
  trial.value = null
  currentBatchNo.value = null
  acknowledged.value = {}
}

function toInputs(): BatchCandidateInput[] {
  return rows.value.map((row) => ({
    hazardCode: row.hazardCode,
    monitorType: row.monitorType,
    notice: row.notice,
    warning: row.warning,
    alert: row.alert,
    effectiveTime: row.effectiveTime || effectiveTime.value,
    setter: row.setter || setter.value,
  }))
}

function conflictKey(conflict: Conflict): string {
  return `${conflict.hazardCode}@@${conflict.monitorType}@@${conflict.kind}`
}

function toggleAck(conflict: Conflict) {
  const key = conflictKey(conflict)
  acknowledged.value[key] = !acknowledged.value[key]
}

function allConfirmAcked(): boolean {
  const confirms = trial.value?.conflicts.filter((item) => item.severity === 'confirm') ?? []
  return confirms.every((item) => acknowledged.value[conflictKey(item)])
}

function runTrial() {
  // 行内的生效时间/设定人跟随顶部统一值补齐。
  for (const row of rows.value) {
    row.effectiveTime = effectiveTime.value
    row.setter = setter.value
  }
  trial.value = previewBatch(toInputs(), currentBatchNo.value ?? undefined)
  step.value = 2
  // 重新试算后，旧的确认勾选只保留仍存在的冲突项。
  const nextAck: Record<string, boolean> = {}
  for (const conflict of trial.value.conflicts) {
    const key = conflictKey(conflict)
    if (acknowledged.value[key]) {
      nextAck[key] = true
    }
  }
  acknowledged.value = nextAck
  return trial.value
}

function onTrial() {
  message.value = ''
  runTrial()
}

function onSaveDraft() {
  const saved = saveDraft(toInputs(), {
    batchNo: currentBatchNo.value ?? undefined,
    operator: setter.value || session.operator,
  })
  currentBatchNo.value = saved.batchNo
  batchList.value = listBatches()
  messageOk.value = true
  message.value = `草稿已保存：批次 ${saved.batchNo}，共 ${saved.candidates.length} 条，可随时续编辑`
  step.value = Math.max(step.value, 2)
}

function onPublish() {
  message.value = ''
  const result = runTrial()
  if (!result) {
    return
  }
  if (result.issues.length > 0) {
    messageOk.value = false
    message.value = `存在 ${result.issues.length} 条非法参数，整批未发布，请按上方清单逐条修正`
    return
  }
  if (result.conflicts.some((item) => item.severity === 'block')) {
    messageOk.value = false
    message.value = '存在阻断性版本冲突（重复条目或基线漂移），整批未发布'
    return
  }
  if (!allConfirmAcked()) {
    messageOk.value = false
    message.value = '还有需确认的冲突项未勾选处理规则，确认后才能发布'
    return
  }

  const published = publishBatch(toInputs(), {
    batchNo: currentBatchNo.value ?? undefined,
    operator: setter.value || session.operator,
  })
  messageOk.value = published.ok
  if (published.ok && published.batch) {
    currentBatchNo.value = published.batch.batchNo
    message.value = published.message
    step.value = 3
    // 发布后刷新现行基线展示，再试算一遍让影响面与新基线对齐。
    for (const row of rows.value) {
      row.current = readBaseline({ hazardCode: row.hazardCode, monitorType: row.monitorType })
    }
    runTrial()
  } else {
    message.value = published.message
  }
  batchList.value = listBatches()
}

function loadBatch(batch: (typeof batchList.value)[number]) {
  currentBatchNo.value = batch.batchNo
  setter.value = batch.operator
  rows.value = batch.candidates.map((item) => ({
    ...item,
    key: `${item.hazardCode}@@${item.monitorType}`,
    current: readBaseline({ hazardCode: item.hazardCode, monitorType: item.monitorType }),
  }))
  effectiveTime.value = batch.candidates[0]?.effectiveTime || effectiveTime.value
  selectedHazards.value = [...new Set(batch.candidates.map((item) => item.hazardCode))]
  selectedTypes.value = [...new Set(batch.candidates.map((item) => item.monitorType))]
  trial.value = null
  acknowledged.value = {}
  showDrafts.value = true
  messageOk.value = true
  message.value = `已载入批次 ${batch.batchNo}（${batch.status}）`
}

function discardBatch(batch: (typeof batchList.value)[number]) {
  if (currentBatchNo.value === batch.batchNo) {
    resetRows()
  }
  removeBatch(batch.batchNo)
  batchList.value = listBatches()
}

function formatTime(raw: string): string {
  if (!raw) {
    return '—'
  }
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    return raw
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}
</script>

<style scoped>
.step-bar {
  display: flex;
  gap: 16px;
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--muted);
}
.step-bar li {
  background: #eef2f7;
  border-radius: 999px;
  padding: 4px 14px;
}
.step-bar li.active {
  background: #dbe7ff;
  color: #174ea6;
  font-weight: 600;
}
.card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.card-title {
  margin: 0 0 10px;
  font-size: 15px;
}
.pick-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.pick-item span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}
.check-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-width: 520px;
}
.check-pill {
  font-size: 13px;
  background: #f1f5f9;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 10px;
}
.pick-ops {
  display: flex;
  gap: 8px;
  align-self: flex-end;
  margin-left: auto;
}
.draft-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}
.draft-bar input {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  min-width: 180px;
}
.batch-tag {
  font-size: 12px;
  color: #174ea6;
  background: #e8f0fe;
  border-radius: 999px;
  padding: 3px 10px;
}
.draft-list {
  padding: 10px;
}
.candidate-table input {
  width: 96px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 6px;
}
.baseline-cell {
  font-size: 12px;
}
.muted {
  color: var(--muted);
}
.trial-ops {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
}
.result-section {
  margin-top: 14px;
}
.result-head {
  font-size: 13px;
  margin: 0 0 6px;
}
.issue-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.issue-item {
  border: 1px solid var(--border);
  border-left-width: 4px;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  background: #fbfdff;
}
.issue-item p {
  margin: 0 0 2px;
}
.issue-item.error,
.issue-item.block {
  border-left-color: #b42318;
  background: #fef3f2;
}
.issue-item.confirm {
  border-left-color: #b54708;
  background: #fffaeb;
}
.issue-item.tip {
  border-left-color: #175cd3;
  background: #eff8ff;
}
.conflict-kind {
  font-weight: 600;
}
.rule-text {
  color: var(--muted);
  font-size: 12px;
}
.ack-line {
  font-size: 12px;
  color: #b54708;
}
.block-text {
  color: #b42318;
  font-size: 12px;
}
.impact-table tr.changed {
  background: #fffaeb;
}
.ok-text {
  color: #067647;
  font-size: 13px;
}
.warn-text {
  color: #b54708;
  font-size: 12px;
}
.result-banner {
  font-size: 13px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
}
.link.danger {
  color: #b42318;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
