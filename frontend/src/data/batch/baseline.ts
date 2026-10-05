import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import {
  KIND_BY_NAME,
  LEVELS,
  type AlarmLevel,
  type Baseline,
  type LedgerBaselineStamp,
  type ThresholdKey,
} from './types'

// 阈值台账在通用 EntryRow 之外扩展的字段（候选版本、设定/生效时间）。
export const THRESHOLD_EXTRA_FIELDS = ['版本号', '设定时间', '生效时间']
export const THRESHOLD_VERSION_FIELD = '版本号'
export const THRESHOLD_SET_TIME_FIELD = '设定时间'
export const THRESHOLD_EFFECTIVE_FIELD = '生效时间'

// 台账上同步换基线时写入的戳记字段。
export const LEDGER_BASELINE_CODE = '判定基线'
export const LEDGER_BASELINE_VERSION = '基线版本'
export const LEDGER_BASELINE_TIME = '基线生效时间'
export const LEDGER_JUDGE_LEVEL = '判定等级'

export function thresholdKey(key: ThresholdKey): string {
  return `${key.hazardCode}@@${key.monitorType}`
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function toVersion(value: unknown): number {
  const num = toNumber(value)
  return num === null || num < 1 ? 1 : Math.trunc(num)
}

// 阈值读取链：从通用台账读出一条配置并归一成现行基线。
// 旧配置缺「生效时间」时按「设定时间」回填，两边都缺再退回状态安全值。
export function rowToBaseline(row: EntryRow): Baseline | null {
  const hazardCode = String(row['隐患点编号'] ?? '').trim()
  const monitorType = String(row['监测类型'] ?? '').trim()
  if (!hazardCode || !monitorType) {
    return null
  }
  const levels = {} as Record<AlarmLevel, number>
  for (const level of LEVELS) {
    const value = toNumber(row[`${level}阈值`])
    if (value === null) {
      return null
    }
    levels[level] = value
  }
  const setTime = String(row[THRESHOLD_SET_TIME_FIELD] ?? '').trim()
  let effectiveTime = String(row[THRESHOLD_EFFECTIVE_FIELD] ?? '').trim()
  if (!effectiveTime) {
    // 旧配置缺生效时间：按设定时间回填。
    effectiveTime = setTime
  }
  return {
    rowId: Number(row.id),
    thresholdCode: String(row['阈值编号'] ?? '').trim(),
    version: toVersion(row[THRESHOLD_VERSION_FIELD]),
    hazardCode,
    monitorType,
    levels,
    setter: String(row['设定人'] ?? '').trim(),
    status: String(row.status ?? ''),
    setTime,
    effectiveTime,
  }
}

// 读取某一键的现行基线：已生效/已调整的最高版本即现行；已废止与草稿不参与判定。
export function readBaseline(key: ThresholdKey): Baseline | null {
  const rows = listRows('threshold')
  const candidates = rows
    .map(rowToBaseline)
    .filter((item): item is Baseline => item !== null)
    .filter(
      (item) =>
        item.hazardCode === key.hazardCode &&
        item.monitorType === key.monitorType &&
        (item.status === '已生效' || item.status === '已调整'),
    )
  if (candidates.length === 0) {
    return null
  }
  return candidates.sort((a, b) => b.version - a.version)[0]
}

export function readAllBaselines(): Map<string, Baseline> {
  const map = new Map<string, Baseline>()
  for (const row of listRows('threshold')) {
    const baseline = rowToBaseline(row)
    if (!baseline || (baseline.status !== '已生效' && baseline.status !== '已调整')) {
      continue
    }
    const key = thresholdKey(baseline)
    const existed = map.get(key)
    if (!existed || baseline.version > existed.version) {
      map.set(key, baseline)
    }
  }
  return map
}

// 预警判定链：按 注意 < 警示 < 警戒 递增，达到哪一档就是哪一级；取不到数或阈值缺失不判。
export function judgeLevel(value: number | null, baseline: Pick<Baseline, 'levels'> | null): AlarmLevel | null {
  if (value === null || !baseline) {
    return null
  }
  let hit: AlarmLevel | null = null
  for (const level of LEVELS) {
    if (value >= baseline.levels[level]) {
      hit = level
    }
  }
  return hit
}

// 读台账观测值：雨量取小时最大雨强、倾斜取倾斜角度，顺着监测类型映射到对应取数链。
export function readObservationValue(
  row: EntryRow,
  monitorType: string,
): { chainKey: string; numericValue: number | null } | null {
  const chain = KIND_BY_NAME.get(monitorType)
  if (!chain) {
    return null
  }
  return { chainKey: chain.moduleKey, numericValue: toNumber(row[chain.valueField]) }
}

export function baselineStamp(baseline: Baseline): LedgerBaselineStamp {
  return {
    thresholdCode: baseline.thresholdCode,
    version: baseline.version,
    effectiveTime: baseline.effectiveTime,
  }
}

// 台账记录上已经盖过的基线戳记，用于发布前后对比。
export function readLedgerStamp(row: EntryRow): LedgerBaselineStamp | null {
  const code = String(row[LEDGER_BASELINE_CODE] ?? '').trim()
  if (!code) {
    return null
  }
  return {
    thresholdCode: code,
    version: toVersion(row[LEDGER_BASELINE_VERSION]),
    effectiveTime: String(row[LEDGER_BASELINE_TIME] ?? '').trim(),
  }
}

// 台账上的「判定等级」列（老数据可能没有，没有就按当前基线现算）。
export function readLedgerLevel(row: EntryRow): AlarmLevel | null {
  const raw = String(row[LEDGER_JUDGE_LEVEL] ?? '').trim()
  return (LEVELS as string[]).includes(raw) ? (raw as AlarmLevel) : null
}
