import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import {
  LEDGER_BASELINE_CODE,
  LEDGER_BASELINE_TIME,
  LEDGER_BASELINE_VERSION,
  LEDGER_JUDGE_LEVEL,
  THRESHOLD_EFFECTIVE_FIELD,
  THRESHOLD_SET_TIME_FIELD,
  THRESHOLD_VERSION_FIELD,
  judgeLevel,
  thresholdKey,
} from './baseline'
import { commitSnapshot, getBatch, newBatchNo, upsertBatch } from './batch-store'
import { KIND_CHAINS, type BatchCandidate, type BatchRecord, type PublishResult } from './types'
import { detectConflicts, runTrial, snapshotOf, validateCandidates } from './trial'

function nextThresholdCode(existing: EntryRow[]): string {
  let max = 0
  for (const row of existing) {
    const match = /THRE-(\d+)/.exec(String(row['阈值编号'] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `THRE-${String(max + 1).padStart(4, '0')}`
}

function nextRowId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

type Prepared = {
  batch: BatchRecord
  candidate: BatchCandidate
  thresholdCode: string
  version: number
}

// 发布前预演：校验、冲突再确认、构造新版本号。任何一步不通过都不进入事务。
function prepare(inputs: BatchRecord['candidates'], batch: BatchRecord): { prepared: Prepared[] } | PublishResult {
  const { candidates, issues } = validateCandidates(inputs)
  if (issues.length > 0) {
    return { ok: false, message: `存在 ${issues.length} 条非法参数，已逐条标出，请修正后再发布`, issues }
  }

  // 发布瞬间以最新基线重建快照并再查一次漂移，杜绝试算后被人抢先发布。
  const freshSnapshot = snapshotOf(candidates)
  const conflicts = detectConflicts(candidates, {
    selfBatchNo: batch.batchNo,
    baselineSnapshot: freshSnapshot,
  }).filter((item) => item.severity === 'block')
  if (conflicts.length > 0) {
    return { ok: false, message: `存在 ${conflicts.length} 项阻断性版本冲突，整批未发布`, conflicts }
  }

  const thresholdRows = listRows('threshold')
  const prepared: Prepared[] = candidates.map((candidate) => {
    const sameKey = thresholdRows
      .filter(
        (row) =>
          String(row['隐患点编号'] ?? '').trim() === candidate.hazardCode &&
          String(row['监测类型'] ?? '').trim() === candidate.monitorType,
      )
      .map((row) => ({ row, version: Number(row[THRESHOLD_VERSION_FIELD] ?? 1) || 1 }))
    const current = sameKey
      .filter((item) => {
        const status = String(item.row.status)
        return status === '已生效' || status === '已调整'
      })
      .sort((a, b) => b.version - a.version)[0]

    return {
      batch,
      candidate,
      // 新版本沿用原阈值编号，保证台账基线戳记能对上同一条配置；新键才发新编号。
      thresholdCode: current ? String(current.row['阈值编号']) : nextThresholdCode(thresholdRows),
      version: (current?.version ?? 0) + 1,
    }
  })

  return { prepared }
}

// 执行整批事务：阈值新版本 + 雨量/倾斜台账换基线，全部成功才落盘。
function execute(prepared: Prepared[], batch: BatchRecord, publishedAt: string): BatchRecord {
  const snapshot: Record<string, EntryRow[]> = {
    threshold: listRows('threshold').map((row) => ({ ...row })),
  }
  for (const chain of KIND_CHAINS) {
    snapshot[chain.moduleKey] = listRows(chain.moduleKey).map((row) => ({ ...row }))
  }

  const preparedByKey = new Map(prepared.map((item) => [thresholdKey(item.candidate), item]))

  // 1) 旧的生效版本收口为「已调整」（废止的不动），再追加新版本行。
  for (const item of prepared) {
    snapshot.threshold = snapshot.threshold.map((row) => {
      const isSameKey =
        String(row['隐患点编号'] ?? '').trim() === item.candidate.hazardCode &&
        String(row['监测类型'] ?? '').trim() === item.candidate.monitorType
      if (!isSameKey) {
        return row
      }
      const status = String(row.status)
      if (status === '已生效' || status === '已调整') {
        return { ...row, status: '已调整', pending: true }
      }
      return row
    })
  }

  for (const item of prepared) {
    const candidate = item.candidate
    snapshot.threshold.push({
      id: nextRowId(snapshot.threshold),
      status: '已生效',
      pending: false,
      abnormal: false,
      阈值编号: item.thresholdCode,
      隐患点编号: candidate.hazardCode,
      监测类型: candidate.monitorType,
      注意级阈值: candidate.notice,
      警示级阈值: candidate.warning,
      警戒级阈值: candidate.alert,
      设定人: candidate.setter,
      生效状态: '已生效',
      [THRESHOLD_VERSION_FIELD]: item.version,
      // 旧配置缺生效时间按设定时间回填；新版本要求两者都有，这里保持一致语义。
      [THRESHOLD_SET_TIME_FIELD]: candidate.effectiveTime,
      [THRESHOLD_EFFECTIVE_FIELD]: candidate.effectiveTime,
    })
  }

  // 2) 顺着取数链给雨量/倾斜台账换基线，并按新基线重新判定等级。
  for (const chain of KIND_CHAINS) {
    snapshot[chain.moduleKey] = snapshot[chain.moduleKey].map((row) => {
      const hazardCode = String(row['隐患点编号'] ?? '').trim()
      const item = preparedByKey.get(`${hazardCode}@@${chain.kind}`)
      if (!item) {
        return row
      }
      const raw = Number(row[chain.valueField])
      const value = Number.isFinite(raw) ? raw : null
      const level = judgeLevel(value, {
        levels: {
          注意级: item.candidate.notice,
          警示级: item.candidate.warning,
          警戒级: item.candidate.alert,
        },
      })
      return {
        ...row,
        [LEDGER_BASELINE_CODE]: item.thresholdCode,
        [LEDGER_BASELINE_VERSION]: item.version,
        [LEDGER_BASELINE_TIME]: item.candidate.effectiveTime,
        [LEDGER_JUDGE_LEVEL]: level ?? '',
      }
    })
  }

  // 3) 所有模块的新台账一次提交；中途失败由 commitSnapshot 整体回退。
  commitSnapshot(snapshot)

  const published: BatchRecord = {
    ...batch,
    status: '已发布',
    updatedAt: publishedAt,
    publishedAt,
    baselineSnapshot: prepared.map((item) => ({
      key: thresholdKey(item.candidate),
      version: item.version,
    })),
    publishedVersions: prepared.map((item) => ({
      thresholdCode: item.thresholdCode,
      version: item.version,
    })),
  }
  upsertBatch(published)
  return published
}

// 存草稿：校验照做并提示，但草稿允许带着非法参数保存，方便下次接着改。
export function saveDraft(
  inputs: BatchRecord['candidates'],
  options: { batchNo?: string; operator: string; now?: Date },
): BatchRecord {
  const now = options.now ?? new Date()
  const stamp = now.toISOString()
  const existed = options.batchNo ? getBatch(options.batchNo) : null
  const batch: BatchRecord = existed
    ? { ...existed, candidates: inputs.map((item) => ({ ...item })), updatedAt: stamp }
    : {
        batchNo: newBatchNo(now),
        operator: options.operator,
        createdAt: stamp,
        updatedAt: stamp,
        status: '草稿',
        candidates: inputs.map((item) => ({ ...item })),
      }
  return upsertBatch(batch)
}

// 发布：幂等。已发布批次重复发布直接返回原结果，绝不再造一套版本。
export function publishBatch(
  inputs: BatchRecord['candidates'],
  options: { batchNo?: string; operator: string; now?: Date },
): PublishResult {
  const now = options.now ?? new Date()
  const stamp = now.toISOString()

  if (options.batchNo) {
    const existed = getBatch(options.batchNo)
    if (existed?.status === '已发布') {
      return {
        ok: true,
        message: `批次 ${existed.batchNo} 已发布（${existed.publishedAt ?? ''}），本次为重复提交，未生成新版本`,
        batch: existed,
      }
    }
  }

  const batch = saveDraft(inputs, { batchNo: options.batchNo, operator: options.operator, now })
  const result = prepare(inputs, batch)
  if (!('prepared' in result)) {
    return result
  }
  try {
    const published = execute(result.prepared, batch, stamp)
    return {
      ok: true,
      message: `批次 ${published.batchNo} 整批发布成功，新增 ${published.publishedVersions?.length ?? 0} 个阈值版本，雨量/倾斜判定基线已同步`,
      batch: published,
    }
  } catch (error) {
    // 事务已回退；批次保留为草稿，修正后可再次发布。
    return {
      ok: false,
      message: `整批事务失败，阈值与台账已一起回退：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

// 只读试算，供试算台在不落盘的前提下算影响面与版本冲突。
export function previewBatch(inputs: BatchRecord['candidates'], batchNo?: string) {
  return runTrial(inputs, { selfBatchNo: batchNo })
}
