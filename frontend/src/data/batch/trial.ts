import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import {
  judgeLevel,
  readAllBaselines,
  readBaseline,
  readLedgerLevel,
  readObservationValue,
  thresholdKey,
} from './baseline'
import { getBatch, listBatches } from './batch-store'
import {
  KIND_CHAINS,
  type Baseline,
  type BatchCandidate,
  type BatchCandidateInput,
  type CandidateIssue,
  type Conflict,
  type ImpactRow,
  type ImpactSummary,
  type ThresholdKey,
  type TrialResult,
} from './types'

function toIssue(
  index: number,
  input: BatchCandidateInput,
  field: string,
  message: string,
): CandidateIssue {
  return {
    index,
    hazardCode: input.hazardCode,
    monitorType: input.monitorType,
    field,
    message,
  }
}

// 阈值合法性：非空、有限数值、大于 0；三档之间的递增关系在三条都解析成功后单独校验。
function parseLevel(
  raw: string,
  index: number,
  input: BatchCandidateInput,
  field: string,
): { issue: CandidateIssue } | { value: number } {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return { issue: toIssue(index, input, field, `${field}不能为空`) }
  }
  const num = Number(text)
  if (!Number.isFinite(num)) {
    return { issue: toIssue(index, input, field, `${field}必须是数值，当前为「${text}」`) }
  }
  if (num <= 0) {
    return { issue: toIssue(index, input, field, `${field}必须大于 0，当前为 ${num}`) }
  }
  return { value: num }
}

// 逐条校验候选参数，任一参数非法都定位到具体条目（序号+隐患点+监测类型+字段）。
export function validateCandidates(inputs: BatchCandidateInput[]): {
  candidates: BatchCandidate[]
  issues: CandidateIssue[]
} {
  const candidates: BatchCandidate[] = []
  const issues: CandidateIssue[] = []

  inputs.forEach((input, index) => {
    const localIssues: CandidateIssue[] = []
    if (!input.hazardCode.trim()) {
      localIssues.push(toIssue(index, input, '隐患点编号', '隐患点编号不能为空'))
    }
    if (!input.monitorType.trim()) {
      localIssues.push(toIssue(index, input, '监测类型', '监测类型不能为空'))
    } else if (!KIND_CHAINS.some((chain) => chain.kind === input.monitorType.trim())) {
      localIssues.push(
        toIssue(index, input, '监测类型', `监测类型仅支持：${KIND_CHAINS.map((c) => c.kind).join('、')}`),
      )
    }
    if (!input.effectiveTime.trim()) {
      localIssues.push(toIssue(index, input, '生效时间', '生效时间不能为空'))
    }
    if (!input.setter.trim()) {
      localIssues.push(toIssue(index, input, '设定人', '设定人不能为空'))
    }

    const parsed: Record<string, number> = {}
    const levelFields = ['注意级阈值', '警示级阈值', '警戒级阈值'] as const
    const raws = [input.notice, input.warning, input.alert]
    levelFields.forEach((field, fieldIndex) => {
      const result = parseLevel(raws[fieldIndex], index, input, field)
      if ('issue' in result) {
        localIssues.push(result.issue)
      } else {
        parsed[field] = result.value
      }
    })

    const notice = parsed['注意级阈值']
    const warning = parsed['警示级阈值']
    const alert = parsed['警戒级阈值']
    if (
      notice !== undefined &&
      warning !== undefined &&
      alert !== undefined &&
      !(notice < warning && warning < alert)
    ) {
      localIssues.push(
        toIssue(index, input, '阈值', `阈值须满足 注意级(${notice}) < 警示级(${warning}) < 警戒级(${alert})`),
      )
    }

    if (localIssues.length === 0) {
      candidates.push({
        hazardCode: input.hazardCode.trim(),
        monitorType: input.monitorType.trim(),
        notice: parsed['注意级阈值'],
        warning: parsed['警示级阈值'],
        alert: parsed['警戒级阈值'],
        effectiveTime: input.effectiveTime.trim(),
        setter: input.setter.trim(),
      })
    }
    issues.push(...localIssues)
  })

  return { candidates, issues }
}

// 影响面：顺着雨量/倾斜取数链，把候选键覆盖到的观测记录都找出来并试算重判。
export function evaluateImpact(candidates: BatchCandidate[]): ImpactSummary {
  const rainRows: ImpactRow[] = []
  const tiltRows: ImpactRow[] = []
  const hazardSet = new Set<string>()
  let affectedRows = 0
  let changedRows = 0
  let unreadableRows = 0

  const candidateByKey = new Map(candidates.map((candidate) => [thresholdKey(candidate), candidate]))
  const currentBaselines = readAllBaselines()

  for (const chain of KIND_CHAINS) {
    const rows: EntryRow[] = listRows(chain.moduleKey)
    for (const row of rows) {
      const hazardCode = String(row['隐患点编号'] ?? '').trim()
      const candidate = candidateByKey.get(`${hazardCode}@@${chain.kind}`)
      if (!hazardCode || !candidate) {
        continue
      }
      hazardCode && hazardSet.add(hazardCode)
      affectedRows += 1

      const observed = readObservationValue(row, chain.kind)
      const numericValue = observed?.numericValue ?? null
      if (numericValue === null) {
        unreadableRows += 1
      }

      const before =
        readLedgerLevel(row) ?? judgeLevel(numericValue, currentBaselines.get(thresholdKey(candidate)) ?? null)
      const after = judgeLevel(numericValue, {
        levels: {
          注意级: candidate.notice,
          警示级: candidate.warning,
          警戒级: candidate.alert,
        },
      })
      const changed = before !== after
      if (changed) {
        changedRows += 1
      }

      const impactRow: ImpactRow = {
        moduleKey: chain.moduleKey,
        rowId: Number(row.id),
        recordCode: String(row['记录编号'] ?? ''),
        hazardCode,
        monitorType: chain.kind,
        valueField: chain.valueField,
        rawValue: String(row[chain.valueField] ?? ''),
        numericValue,
        beforeLevel: before,
        afterLevel: after,
        changed,
      }
      if (chain.kind === '雨量') {
        rainRows.push(impactRow)
      } else {
        tiltRows.push(impactRow)
      }
    }
  }

  return {
    rainRows,
    tiltRows,
    affectedHazards: hazardSet.size,
    affectedRows,
    changedRows,
    unreadableRows,
  }
}

// 版本冲突：候选参数与现行配置打架时的处理规则集中在这里判定。
// 处理规则（定稿）：
//  1. duplicate       同批次同键多条：整批阻断，必须并成一条再试算；
//  2. baselineChanged 草稿试算后现行版本漂移：阻断，按最新基线重新试算；
//  3. draftExists     该键已存在其他批次的未发布草稿：需确认，保存将覆盖该键草稿；
//  4. currentObsolete 现行配置已废止：需确认，发布后按新版本重建基线；
//  5. noBaseline      该键尚无配置：仅提示，发布后首次建立基线。
export function detectConflicts(
  candidates: BatchCandidate[],
  options: { selfBatchNo?: string; baselineSnapshot?: { key: string; version: number }[] } = {},
): Conflict[] {
  const conflicts: Conflict[] = []
  const seen = new Map<string, number>()
  const otherDrafts = listBatches().filter(
    (batch) => batch.status === '草稿' && batch.batchNo !== options.selfBatchNo,
  )

  candidates.forEach((candidate, index) => {
    const key = thresholdKey(candidate)

    const firstIndex = seen.get(key)
    if (firstIndex !== undefined) {
      conflicts.push({
        ...keyOf(candidate),
        kind: 'duplicate',
        detail: `第 ${firstIndex + 1} 条与第 ${index + 1} 条的隐患点+监测类型相同`,
        rule: '同一批次对同一键只能保留一条候选，请合并后再试算',
        severity: 'block',
      })
    } else {
      seen.set(key, index)
    }

    const snapshot = options.baselineSnapshot?.find((item) => item.key === key)
    const latest = readBaseline(candidate)
    if (snapshot && latest && snapshot.version !== latest.version) {
      conflicts.push({
        ...keyOf(candidate),
        kind: 'baselineChanged',
        detail: `试算时现行版本为 v${snapshot.version}，当前已变为 v${latest.version}`,
        rule: '以当前最新基线为准，重新试算确认影响面后才能发布',
        severity: 'block',
      })
    }

    const otherDraft = otherDrafts.find((batch) =>
      batch.candidates.some(
        (item) =>
          item.hazardCode.trim() === candidate.hazardCode &&
          item.monitorType.trim() === candidate.monitorType,
      ),
    )
    if (otherDraft) {
      conflicts.push({
        ...keyOf(candidate),
        kind: 'draftExists',
        detail: `批次 ${otherDraft.batchNo}（草稿）已包含该键的候选参数`,
        rule: '保存草稿将覆盖该键在旧批次中的候选；发布后旧批次对应条目随版本作废',
        severity: 'confirm',
      })
    }

    const sameKeyRows = listRows('threshold').filter(
      (row) =>
        String(row['隐患点编号'] ?? '').trim() === candidate.hazardCode &&
        String(row['监测类型'] ?? '').trim() === candidate.monitorType,
    )
    const hasActive = sameKeyRows.some((row) => {
      const status = String(row.status)
      return status === '已生效' || status === '已调整'
    })
    if (!hasActive) {
      if (sameKeyRows.some((row) => String(row.status) === '已废止')) {
        conflicts.push({
          ...keyOf(candidate),
          kind: 'currentObsolete',
          detail: '该键的现行配置已废止',
          rule: '发布后以新版本重建基线，并同步替换雨量/倾斜台账的判定基线',
          severity: 'confirm',
        })
      } else if (sameKeyRows.length === 0) {
        conflicts.push({
          ...keyOf(candidate),
          kind: 'noBaseline',
          detail: '该隐患点+监测类型尚无任何阈值配置',
          rule: '发布后首次建立基线',
          severity: 'tip',
        })
      }
    }
  })

  return conflicts
}

function keyOf(key: ThresholdKey): ThresholdKey {
  return { hazardCode: key.hazardCode, monitorType: key.monitorType }
}

export function snapshotOf(candidates: BatchCandidate[]): { key: string; version: number }[] {
  return candidates.map((candidate) => {
    const current = readBaseline(candidate)
    return { key: thresholdKey(candidate), version: current?.version ?? 0 }
  })
}

export function runTrial(
  inputs: BatchCandidateInput[],
  options: { selfBatchNo?: string } = {},
): TrialResult {
  const { candidates, issues } = validateCandidates(inputs)
  const self = options.selfBatchNo ? getBatch(options.selfBatchNo) : null
  const conflicts = detectConflicts(candidates, {
    selfBatchNo: options.selfBatchNo,
    baselineSnapshot: self?.baselineSnapshot,
  })
  const impact = evaluateImpact(candidates)

  const baselines = new Map<string, Baseline>()
  for (const candidate of candidates) {
    const current = readBaseline(candidate)
    if (current) {
      baselines.set(thresholdKey(candidate), current)
    }
  }

  const hasBlock = issues.length > 0 || conflicts.some((item) => item.severity === 'block')
  return { candidates, issues, conflicts, baselines, impact, canPublish: !hasBlock }
}
