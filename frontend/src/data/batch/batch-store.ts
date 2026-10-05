import { allRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import type { BatchRecord } from './types'

// 草稿单独存一份，不进通用台账：试算台可以随时存草稿、关掉再打开继续。
const DRAFT_KEY = 'geohazard-monitor-prevention:threshold-batches'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type DraftState = { batches: BatchRecord[] }

function readDraftState(): DraftState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { batches: [] }
  }
  const raw = window.localStorage.getItem(DRAFT_KEY)
  if (!raw) {
    return { batches: [] }
  }
  try {
    const parsed = JSON.parse(raw) as DraftState
    return { batches: Array.isArray(parsed.batches) ? parsed.batches : [] }
  } catch {
    return { batches: [] }
  }
}

function writeDraftState(state: DraftState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(state))
  }
}

export function listBatches(): BatchRecord[] {
  return readDraftState().batches
}

export function getBatch(batchNo: string): BatchRecord | null {
  return listBatches().find((item) => item.batchNo === batchNo) ?? null
}

// 批次号幂等：已发布的批次再点发布只返回原批次，不会多出一套版本。
export function upsertBatch(record: BatchRecord): BatchRecord {
  const state = readDraftState()
  const index = state.batches.findIndex((item) => item.batchNo === record.batchNo)
  const next = clone(record)
  if (index >= 0) {
    state.batches[index] = next
  } else {
    state.batches.unshift(next)
  }
  writeDraftState(state)
  return next
}

export function removeBatch(batchNo: string): void {
  const state = readDraftState()
  writeDraftState({ batches: state.batches.filter((item) => item.batchNo !== batchNo) })
}

export function newBatchNo(now = new Date()): string {
  const pad = (num: number) => String(num).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `BATCH-${stamp}`
}

// 整批事务：基于快照构造好所有模块的新台账后一次落盘。
// saveRows 每调一次只写一个模块，因此这里先算齐 nextSnapshot，再顺序提交；
// 任一模块写入失败，用上一份快照整体回退，保证一起成功或一起回退。
export function commitSnapshot(nextSnapshot: Record<string, EntryRow[]>): void {
  const rollback = clone(allRows())
  const keys = Object.keys(nextSnapshot)
  try {
    for (const key of keys) {
      saveRows(key, nextSnapshot[key])
    }
  } catch (error) {
    for (const key of keys) {
      saveRows(key, rollback[key] ?? [])
    }
    throw error
  }
}
