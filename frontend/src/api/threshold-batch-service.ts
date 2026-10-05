import { allRows, listRows, saveAllRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 预警阈值批量试算台：沿着「阈值读取(threshold) → 预警判定(judgeLevel) →
// 雨量/倾斜取数(rain_gauge/tilt)」这条链组织，页面只调这里，不自己写业务判断。
//
// 候选参数与现行配置打架时的处理规则（本台约定）：
//   1. 现行已有「已生效」配置（同隐患点+同监测类型）→ 候选作为下一版本整批替换，
//      旧版本归档进版本台账；旧配置缺生效时间的，按本批设定时间回填。
//   2. 现行仅有「草稿」配置 → 草稿直接转正为 v1，不另占版本号。
//   3. 候选三级阈值与现行完全一致 → 判为重复，发布时跳过该条，不产生新版本。
//   4. 同一批次内同隐患点+同监测类型出现多条 → 判非法，整批不得发布。
//   5. 发布是整批事务：阈值配置、版本台账、雨量/倾斜判定台账一起成功或一起回退。
//   6. 批次一旦发布，重复发布不再生成第二套版本（幂等）。

export const MONITOR_TYPES = ['雨量监测', '倾斜监测'] as const
export type MonitorType = (typeof MONITOR_TYPES)[number]

const HAZARD_KEY = 'hazard'
const THRESHOLD_KEY = 'threshold'
const RAIN_KEY = 'rain_gauge'
const TILT_KEY = 'tilt'
const ALARM_KEY = 'alarm'
const BATCH_KEY = 'threshold_batch'
const VERSION_KEY = 'threshold_version'

const STATUS_DRAFT = '草稿'
const STATUS_EFFECTIVE = '已生效'
const STATUS_RETIRED = '已调整'

export type Levels = { 注意: number; 警示: number; 警戒: number }

export type CandidateItem = {
  rowNo: number
  隐患点编号: string
  隐患点名称: string
  监测类型: MonitorType
  注意级阈值: string
  警示级阈值: string
  警戒级阈值: string
  设定人: string
  生效时间: string
}

export type ItemIssue = { rowNo: number; label: string; message: string }

export type ConflictKind = '新增' | '覆盖草稿' | '替换现行' | '与现行一致'

export type ImpactRow = {
  rowNo: number
  台账: MonitorType
  记录编号: string
  隐患点编号: string
  观测值: number
  旧判定: string
  新判定: string
}

export type ItemTrial = {
  item: CandidateItem
  issues: ItemIssue[]
  conflict: ConflictKind
  conflictNote: string
  currentVersion: number | null
  nextVersion: number | null
  impacts: ImpactRow[]
}

export type TrialResult = {
  passed: boolean
  items: ItemTrial[]
  issues: ItemIssue[]
  impacts: ImpactRow[]
  relatedAlarms: number
  summary: {
    total: number
    invalid: number
    replacing: number
    additions: number
    skipped: number
    rainRebased: number
    tiltRebased: number
  }
}

export type PublishResult = {
  ok: boolean
  repeated: boolean
  message: string
  invalidItems: string[]
  versions: string[]
  rainRebased: number
  tiltRebased: number
}

// ---------- 预警判定 ----------

export function judgeLevel(value: number, levels: Levels): string {
  if (value >= levels.警戒) return '警戒级'
  if (value >= levels.警示) return '警示级'
  if (value >= levels.注意) return '注意级'
  return '未触发'
}

// ---------- 阈值读取 ----------

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function versionOf(row: EntryRow): number {
  return num(row['版本'])
}

function levelsFromRow(row: EntryRow): Levels {
  return { 注意: num(row['注意级阈值']), 警示: num(row['警示级阈值']), 警戒: num(row['警戒级阈值']) }
}

function sameKey(row: EntryRow, hazardCode: string, monitorType: string): boolean {
  return row['隐患点编号'] === hazardCode && row['监测类型'] === monitorType
}

// 现行基线：同隐患点+同监测类型下状态「已生效」且版本最高的那条。
function baselineIndex(rows: EntryRow[], hazardCode: string, monitorType: string): number {
  let best = -1
  let bestVersion = -1
  rows.forEach((row, index) => {
    if (sameKey(row, hazardCode, monitorType) && row.status === STATUS_EFFECTIVE) {
      const version = versionOf(row)
      if (version > bestVersion) {
        best = index
        bestVersion = version
      }
    }
  })
  return best
}

export function currentBaseline(hazardCode: string, monitorType: string): EntryRow | null {
  const rows = listRows(THRESHOLD_KEY)
  const index = baselineIndex(rows, hazardCode, monitorType)
  return index >= 0 ? rows[index] : null
}

function currentDraft(hazardCode: string, monitorType: string): EntryRow | null {
  return (
    listRows(THRESHOLD_KEY).find(
      (row) => sameKey(row, hazardCode, monitorType) && row.status === STATUS_DRAFT,
    ) ?? null
  )
}

// ---------- 候选参数 ----------

export function hazardOptions(): { code: string; name: string }[] {
  return listRows(HAZARD_KEY).map((row) => ({
    code: String(row['隐患点编号'] ?? ''),
    name: String(row['隐患点名称'] ?? ''),
  }))
}

export function buildCandidates(
  codes: string[],
  types: MonitorType[],
  operator: string,
  effectiveDate: string,
): CandidateItem[] {
  const names = new Map(hazardOptions().map((item) => [item.code, item.name]))
  const items: CandidateItem[] = []
  let rowNo = 1
  for (const code of codes) {
    for (const type of types) {
      const source = currentBaseline(code, type) ?? currentDraft(code, type)
      items.push({
        rowNo: rowNo++,
        隐患点编号: code,
        隐患点名称: names.get(code) ?? '',
        监测类型: type,
        注意级阈值: source ? String(source['注意级阈值'] ?? '') : '',
        警示级阈值: source ? String(source['警示级阈值'] ?? '') : '',
        警戒级阈值: source ? String(source['警戒级阈值'] ?? '') : '',
        设定人: operator,
        生效时间: effectiveDate,
      })
    }
  }
  return items
}

function parseLevels(item: CandidateItem): Levels | null {
  const levels = { 注意: Number(item.注意级阈值), 警示: Number(item.警示级阈值), 警戒: Number(item.警戒级阈值) }
  if (![levels.注意, levels.警示, levels.警戒].every(Number.isFinite)) return null
  return levels
}

function sameLevels(row: EntryRow, item: CandidateItem): boolean {
  const levels = parseLevels(item)
  if (!levels) return false
  const current = levelsFromRow(row)
  return current.注意 === levels.注意 && current.警示 === levels.警示 && current.警戒 === levels.警戒
}

// ---------- 试算 ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function validateItem(item: CandidateItem, hazardCodes: Set<string>): ItemIssue[] {
  const issues: ItemIssue[] = []
  const label = `第${item.rowNo}行 ${item.隐患点编号 || '?'}/${item.监测类型}`
  const push = (message: string) => issues.push({ rowNo: item.rowNo, label, message })

  if (!item.隐患点编号.trim()) push('隐患点为空')
  else if (!hazardCodes.has(item.隐患点编号)) push(`隐患点 ${item.隐患点编号} 未在隐患点台账登记`)
  if (!MONITOR_TYPES.includes(item.监测类型)) {
    push(`监测类型「${item.监测类型}」不支持，试算台只接雨量监测、倾斜监测两条取数链`)
  }
  const rawLevels: [string, string][] = [
    ['注意级阈值', item.注意级阈值],
    ['警示级阈值', item.警示级阈值],
    ['警戒级阈值', item.警戒级阈值],
  ]
  for (const [field, value] of rawLevels) {
    if (String(value).trim() === '') push(`${field}为空`)
    else if (!Number.isFinite(Number(value))) push(`${field}「${value}」不是数字`)
    else if (Number(value) <= 0) push(`${field}必须大于 0，当前为「${value}」`)
  }
  const levels = parseLevels(item)
  if (levels && !(levels.注意 < levels.警示 && levels.警示 < levels.警戒)) {
    push(`三级阈值必须满足 注意级 < 警示级 < 警戒级，当前为 ${levels.注意}/${levels.警示}/${levels.警戒}`)
  }
  if (!item.生效时间.trim()) push('生效时间（设定时间）为空')
  else if (!DATE_RE.test(item.生效时间) || Number.isNaN(Date.parse(item.生效时间))) {
    push(`生效时间「${item.生效时间}」不是合法日期，应为 YYYY-MM-DD`)
  }
  if (!item.设定人.trim()) push('设定人为空')
  return issues
}

// 影响面：换基线后判定结论会变化的雨量/倾斜记录。
// 雨量取「日累计雨量」比对三级阈值；倾斜取「累积倾斜量」比对三级阈值。
function impactOf(item: CandidateItem, levels: Levels): ImpactRow[] {
  const baseline = currentBaseline(item.隐患点编号, item.监测类型)
  const oldLevels = baseline ? levelsFromRow(baseline) : null
  const judgeOld = (value: number) => (oldLevels ? judgeLevel(value, oldLevels) : '无基线')
  const impacts: ImpactRow[] = []
  const collect = (key: string, field: string, ledger: MonitorType) => {
    for (const record of listRows(key)) {
      if (record['隐患点编号'] !== item.隐患点编号) continue
      const value = num(record[field])
      const next = judgeLevel(value, levels)
      const prev = judgeOld(value)
      if (prev !== next) {
        impacts.push({
          rowNo: item.rowNo,
          台账: ledger,
          记录编号: String(record['记录编号'] ?? ''),
          隐患点编号: item.隐患点编号,
          观测值: value,
          旧判定: prev,
          新判定: next,
        })
      }
    }
  }
  if (item.监测类型 === '雨量监测') collect(RAIN_KEY, '日累计雨量', '雨量监测')
  if (item.监测类型 === '倾斜监测') collect(TILT_KEY, '累积倾斜量', '倾斜监测')
  return impacts
}

export function trialRun(items: CandidateItem[]): TrialResult {
  const hazardCodes = new Set(hazardOptions().map((item) => item.code))
  const keyToRows = new Map<string, number[]>()
  for (const item of items) {
    const key = `${item.隐患点编号}::${item.监测类型}`
    keyToRows.set(key, [...(keyToRows.get(key) ?? []), item.rowNo])
  }

  const trials: ItemTrial[] = []
  const allIssues: ItemIssue[] = []
  for (const item of items) {
    const issues = validateItem(item, hazardCodes)
    const siblings = keyToRows.get(`${item.隐患点编号}::${item.监测类型}`) ?? []
    if (siblings.length > 1) {
      const others = siblings.filter((rowNo) => rowNo !== item.rowNo).join('、')
      issues.push({
        rowNo: item.rowNo,
        label: `第${item.rowNo}行 ${item.隐患点编号}/${item.监测类型}`,
        message: `与第${others}行重复（同隐患点+同监测类型），一批只允许一条`,
      })
    }

    let conflict: ConflictKind = '新增'
    let conflictNote = '现行无同口径配置，发布后新增为 v1'
    let currentVersion: number | null = null
    let nextVersion: number | null = 1
    const baseline = currentBaseline(item.隐患点编号, item.监测类型)
    const draft = currentDraft(item.隐患点编号, item.监测类型)
    if (baseline) {
      currentVersion = versionOf(baseline)
      if (sameLevels(baseline, item)) {
        conflict = '与现行一致'
        nextVersion = null
        conflictNote = `与现行 ${String(baseline['阈值编号'])} v${currentVersion} 数值一致，发布时跳过，不产生新版本`
      } else {
        conflict = '替换现行'
        nextVersion = currentVersion + 1
        conflictNote = `替换现行 ${String(baseline['阈值编号'])} v${currentVersion} → v${nextVersion}，旧版本归档；旧配置缺生效时间按本批设定时间回填`
      }
    } else if (draft) {
      conflict = '覆盖草稿'
      conflictNote = `现行存在草稿 ${String(draft['阈值编号'])}，发布时草稿转正为 v1`
    }

    const levels = issues.length === 0 ? parseLevels(item) : null
    const impacts = levels && conflict !== '与现行一致' ? impactOf(item, levels) : []
    trials.push({ item, issues, conflict, conflictNote, currentVersion, nextVersion, impacts })
    allIssues.push(...issues)
  }

  const impacts = trials.flatMap((trial) => trial.impacts)
  const selectedCodes = new Set(items.map((item) => item.隐患点编号))
  const relatedAlarms = listRows(ALARM_KEY).filter(
    (row) => selectedCodes.has(String(row['隐患点编号'])) && ['待发布', '已发布'].includes(String(row.status)),
  ).length

  return {
    passed: items.length > 0 && allIssues.length === 0,
    items: trials,
    issues: allIssues,
    impacts,
    relatedAlarms,
    summary: {
      total: items.length,
      invalid: trials.filter((trial) => trial.issues.length > 0).length,
      replacing: trials.filter((trial) => trial.conflict === '替换现行' || trial.conflict === '覆盖草稿').length,
      additions: trials.filter((trial) => trial.conflict === '新增').length,
      skipped: trials.filter((trial) => trial.conflict === '与现行一致').length,
      rainRebased: impacts.filter((impact) => impact.台账 === '雨量监测').length,
      tiltRebased: impacts.filter((impact) => impact.台账 === '倾斜监测').length,
    },
  }
}

// ---------- 草稿 ----------

function pad(value: number): string {
  return String(value).padStart(4, '0')
}

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function maxId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
}

function maxNo(rows: EntryRow[], field: string, prefix: string): number {
  return rows.reduce((max, row) => {
    const raw = String(row[field] ?? '')
    const value = raw.startsWith(prefix) ? Number(raw.slice(prefix.length)) : Number.NaN
    return Number.isFinite(value) ? Math.max(max, value) : max
  }, 0)
}

export function contentHash(items: CandidateItem[]): string {
  const normalized = items
    .map((item) =>
      [item.隐患点编号, item.监测类型, item.注意级阈值, item.警示级阈值, item.警戒级阈值, item.生效时间].join('|'),
    )
    .sort()
    .join('##')
  let hash = 5381
  for (let index = 0; index < normalized.length; index++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(index)) >>> 0
  }
  return hash.toString(16)
}

export type DraftSave = { batchId: string; saved: boolean; message: string }

export function saveDraft(input: { batchId?: string; name: string; items: CandidateItem[] }): DraftSave {
  const rows = [...listRows(BATCH_KEY)]
  const timestamp = now()
  const hash = contentHash(input.items)
  if (input.batchId) {
    const index = rows.findIndex((row) => row['批次号'] === input.batchId)
    if (index >= 0) {
      if (rows[index].status === '已发布') {
        return { batchId: input.batchId, saved: false, message: `批次 ${input.batchId} 已发布，修改未落盘` }
      }
      rows[index] = {
        ...rows[index],
        批次名称: input.name || String(rows[index]['批次名称']),
        条目Json: JSON.stringify(input.items),
        条目数: input.items.length,
        内容哈希: hash,
        更新时间: timestamp,
      }
      saveRows(BATCH_KEY, rows)
      return { batchId: input.batchId, saved: true, message: `草稿 ${input.batchId} 已更新` }
    }
  }
  const batchId = `BATCH-${pad(maxNo(rows, '批次号', 'BATCH-') + 1)}`
  rows.push({
    id: maxId(rows) + 1,
    status: STATUS_DRAFT,
    pending: true,
    abnormal: false,
    批次号: batchId,
    批次名称: input.name || batchId,
    条目Json: JSON.stringify(input.items),
    条目数: input.items.length,
    内容哈希: hash,
    创建时间: timestamp,
    更新时间: timestamp,
    发布时间: '',
    发布摘要: '',
  })
  saveRows(BATCH_KEY, rows)
  return { batchId, saved: true, message: `草稿 ${batchId} 已保存` }
}

export function listBatches(): EntryRow[] {
  return [...listRows(BATCH_KEY)].sort((a, b) => Number(b.id) - Number(a.id))
}

export function loadDraft(batchId: string): { name: string; items: CandidateItem[]; published: boolean } | null {
  const row = listRows(BATCH_KEY).find((item) => item['批次号'] === batchId)
  if (!row) return null
  try {
    return {
      name: String(row['批次名称'] ?? ''),
      items: JSON.parse(String(row['条目Json'] ?? '[]')) as CandidateItem[],
      published: row.status === '已发布',
    }
  } catch {
    return null
  }
}

export function deleteBatch(batchId: string): { ok: boolean; message: string } {
  const rows = listRows(BATCH_KEY)
  const target = rows.find((row) => row['批次号'] === batchId)
  if (!target) return { ok: false, message: `没有找到批次 ${batchId}` }
  if (target.status === '已发布') return { ok: false, message: `批次 ${batchId} 已发布，留在台账里备查，不能删除` }
  saveRows(BATCH_KEY, rows.filter((row) => row['批次号'] !== batchId))
  return { ok: true, message: `草稿 ${batchId} 已删除` }
}

export function listVersions(): EntryRow[] {
  return [...listRows(VERSION_KEY)].sort((a, b) => Number(b.id) - Number(a.id))
}

// ---------- 整批发布 ----------

function rebaseRain(rows: EntryRow[], hazardCode: string, levels: Levels): number {
  let changed = 0
  for (let index = 0; index < rows.length; index++) {
    const record = rows[index]
    if (record['隐患点编号'] !== hazardCode) continue
    const triggered = judgeLevel(num(record['日累计雨量']), levels) !== '未触发'
    const nextFlag = triggered ? '是' : '否'
    let nextStatus = String(record.status)
    if (triggered) nextStatus = '达预警值'
    else if (nextStatus === '达预警值') nextStatus = '已审核'
    if (record['是否触发预警'] === nextFlag && nextStatus === String(record.status)) continue
    rows[index] = { ...record, 是否触发预警: nextFlag, 记录状态: nextStatus, status: nextStatus }
    changed++
  }
  return changed
}

function rebaseTilt(rows: EntryRow[], hazardCode: string, levels: Levels): number {
  let changed = 0
  for (let index = 0; index < rows.length; index++) {
    const record = rows[index]
    if (record['隐患点编号'] !== hazardCode) continue
    const overLimit = judgeLevel(num(record['累积倾斜量']), levels) === '警戒级'
    let nextStatus = String(record.status)
    if (overLimit) nextStatus = '超限报警'
    else if (nextStatus === '超限报警') nextStatus = '已校核'
    if (nextStatus === String(record.status)) continue
    rows[index] = { ...record, 记录状态: nextStatus, status: nextStatus }
    changed++
  }
  return changed
}

export function publishBatch(batchId: string): PublishResult {
  const fail = (message: string, invalidItems: string[] = []): PublishResult => ({
    ok: false,
    repeated: false,
    message,
    invalidItems,
    versions: [],
    rainRebased: 0,
    tiltRebased: 0,
  })

  const batch = listRows(BATCH_KEY).find((row) => row['批次号'] === batchId)
  if (!batch) return fail(`没有找到批次 ${batchId}`)
  if (batch.status === '已发布') {
    return {
      ok: true,
      repeated: true,
      message: `批次 ${batchId} 已发布过，重复发布不生成第二套版本`,
      invalidItems: [],
      versions: [],
      rainRebased: 0,
      tiltRebased: 0,
    }
  }

  let items: CandidateItem[]
  try {
    items = JSON.parse(String(batch['条目Json'] ?? '[]')) as CandidateItem[]
  } catch {
    return fail(`批次 ${batchId} 的候选参数损坏，整批未发布`)
  }
  const trial = trialRun(items)
  if (!trial.passed) {
    return fail(
      `批次存在 ${trial.issues.length} 处非法参数，整批未发布`,
      trial.issues.map((issue) => `${issue.label}：${issue.message}`),
    )
  }

  // 整批事务：先在内存里算完全部新状态，再一次落盘；任一步异常都不写，等于整体回退。
  const snapshot = allRows()
  try {
    const next = { ...snapshot }
    const thresholdRows = [...(snapshot[THRESHOLD_KEY] ?? [])]
    const versionRows = [...(snapshot[VERSION_KEY] ?? [])]
    const rainRows = [...(snapshot[RAIN_KEY] ?? [])]
    const tiltRows = [...(snapshot[TILT_KEY] ?? [])]
    const batchRows = [...(snapshot[BATCH_KEY] ?? [])]

    let nextThresholdId = maxId(thresholdRows) + 1
    let nextThresholdNo = maxNo(thresholdRows, '阈值编号', 'THRE-') + 1
    let nextVersionId = maxId(versionRows) + 1
    let nextVersionNo = maxNo(versionRows, '版本编号', 'VER-') + 1
    const timestamp = now()
    const versions: string[] = []
    let rainRebased = 0
    let tiltRebased = 0

    const appendVersion = (source: EntryRow, version: number, status: string, reason: string, effectiveTime: string) => {
      versionRows.push({
        id: nextVersionId++,
        status,
        pending: false,
        abnormal: false,
        版本编号: `VER-${pad(nextVersionNo++)}`,
        批次号: batchId,
        阈值编号: String(source['阈值编号'] ?? ''),
        隐患点编号: String(source['隐患点编号'] ?? ''),
        监测类型: String(source['监测类型'] ?? ''),
        注意级阈值: num(source['注意级阈值']),
        警示级阈值: num(source['警示级阈值']),
        警戒级阈值: num(source['警戒级阈值']),
        版本: version,
        生效时间: effectiveTime,
        归档原因: reason,
        记录时间: timestamp,
      })
    }

    for (const itemTrial of trial.items) {
      if (itemTrial.conflict === '与现行一致') continue
      const item = itemTrial.item
      const levels = parseLevels(item)
      if (!levels) throw new Error(`第${item.rowNo}行阈值无法解析`)
      const effectiveTime = item.生效时间

      if (itemTrial.conflict === '替换现行') {
        const oldIndex = baselineIndex(thresholdRows, item.隐患点编号, item.监测类型)
        if (oldIndex < 0) throw new Error(`第${item.rowNo}行找不到要替换的现行配置`)
        const oldRow = thresholdRows[oldIndex]
        // 旧配置缺生效时间按本批设定时间回填，再归档。
        const backfilled = String(oldRow['生效时间'] ?? '').trim() === '' ? effectiveTime : String(oldRow['生效时间'])
        const retired: EntryRow = { ...oldRow, status: STATUS_RETIRED, pending: false, 生效状态: STATUS_RETIRED, 生效时间: backfilled }
        thresholdRows[oldIndex] = retired
        appendVersion(retired, versionOf(oldRow), '历史', '被替换', backfilled)
      }

      const nextVersion = itemTrial.nextVersion ?? 1
      if (itemTrial.conflict === '覆盖草稿') {
        const draftIndex = thresholdRows.findIndex(
          (row) => sameKey(row, item.隐患点编号, item.监测类型) && row.status === STATUS_DRAFT,
        )
        if (draftIndex < 0) throw new Error(`第${item.rowNo}行找不到要转正的草稿`)
        const promoted: EntryRow = {
          ...thresholdRows[draftIndex],
          status: STATUS_EFFECTIVE,
          pending: true,
          注意级阈值: levels.注意,
          警示级阈值: levels.警示,
          警戒级阈值: levels.警戒,
          设定人: item.设定人,
          生效状态: STATUS_EFFECTIVE,
          生效时间: effectiveTime,
          版本: nextVersion,
        }
        thresholdRows[draftIndex] = promoted
        appendVersion(promoted, nextVersion, '现行', '草稿转正', effectiveTime)
        versions.push(`${String(promoted['阈值编号'])} ${item.隐患点编号}/${item.监测类型} v${nextVersion}`)
      } else {
        const created: EntryRow = {
          id: nextThresholdId++,
          status: STATUS_EFFECTIVE,
          pending: true,
          abnormal: false,
          阈值编号: `THRE-${pad(nextThresholdNo++)}`,
          隐患点编号: item.隐患点编号,
          监测类型: item.监测类型,
          注意级阈值: levels.注意,
          警示级阈值: levels.警示,
          警戒级阈值: levels.警戒,
          设定人: item.设定人,
          生效状态: STATUS_EFFECTIVE,
          生效时间: effectiveTime,
          版本: nextVersion,
        }
        thresholdRows.push(created)
        appendVersion(created, nextVersion, '现行', itemTrial.conflict === '替换现行' ? '替换生效' : '新发版', effectiveTime)
        versions.push(`${String(created['阈值编号'])} ${item.隐患点编号}/${item.监测类型} v${nextVersion}`)
      }

      // 同步换基线：雨量/倾斜判定台账按新阈值重判。
      if (item.监测类型 === '雨量监测') rainRebased += rebaseRain(rainRows, item.隐患点编号, levels)
      if (item.监测类型 === '倾斜监测') tiltRebased += rebaseTilt(tiltRows, item.隐患点编号, levels)
    }

    const batchIndex = batchRows.findIndex((row) => row['批次号'] === batchId)
    if (batchIndex < 0) throw new Error(`批次 ${batchId} 在发布过程中丢失`)
    batchRows[batchIndex] = {
      ...batchRows[batchIndex],
      status: '已发布',
      pending: false,
      发布时间: timestamp,
      发布摘要: `新版本 ${versions.length} 个，雨量换基线 ${rainRebased} 条，倾斜换基线 ${tiltRebased} 条`,
    }

    next[THRESHOLD_KEY] = thresholdRows
    next[VERSION_KEY] = versionRows
    next[RAIN_KEY] = rainRows
    next[TILT_KEY] = tiltRows
    next[BATCH_KEY] = batchRows
    saveAllRows(next)

    return {
      ok: true,
      repeated: false,
      message:
        versions.length > 0
          ? `批次 ${batchId} 发布成功：${versions.length} 个新版本生效，雨量换基线 ${rainRebased} 条、倾斜换基线 ${tiltRebased} 条`
          : `批次 ${batchId} 发布完成：全部与现行一致，未产生新版本`,
      invalidItems: [],
      versions,
      rainRebased,
      tiltRebased,
    }
  } catch (error) {
    return fail(`发布失败，整批已回退：${error instanceof Error ? error.message : String(error)}`)
  }
}
