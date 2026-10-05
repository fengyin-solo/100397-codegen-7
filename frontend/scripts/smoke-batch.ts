// 批量试算台核心规则冒烟测试：直接跑域层逻辑（localStorage 用内存桩），覆盖
// 参数非法定位、影响面、旧配置回填、事务原子性、重复发布幂等等关键约束。

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function makeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      // 测试可指定第 N 次写入抛错，用来模拟事务中途失败。
      const failAt = (globalThis as any).__failSetItemAt
      const calls = (globalThis as any).__setItemCalls ?? 0
      ;(globalThis as any).__setItemCalls = calls + 1
      if (failAt && calls + 1 === failAt) {
        throw new Error('模拟 localStorage 写入失败')
      }
      map.set(key, value)
    },
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  }
}
;(globalThis as any).window = { localStorage: makeStorage() }
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

import * as store from '../src/data/local-store'
import { readBaseline, judgeLevel } from '../src/data/batch/baseline'
import { previewBatch, publishBatch, saveDraft } from '../src/data/batch/publish'
import { listBatches } from '../src/data/batch/batch-store'

async function main() {
  const { listRows, saveRows } = store
  void saveRows

  // 1. 旧配置缺生效时间按设定时间回填：THRE-0004 无生效时间。
  const tilt0002 = readBaseline({ hazardCode: 'HAZA-0002', monitorType: '倾斜' })
  assert(tilt0002, 'THRE-0004 应能读出基线')
  assert(tilt0002!.effectiveTime === '2026-08-10 00:00', '缺生效时间应回填为设定时间')
  assert(tilt0002!.version === 1, '缺版本字段默认 v1')

  // 2. 判定函数：达级取值、空值不判。
  assert(judgeLevel(42, tilt0002) === '警戒级', '42 对任何阈值都超警戒（类型由取数链选用基线决定）')
  const rain0001 = readBaseline({ hazardCode: 'HAZA-0001', monitorType: '雨量' })
  assert(rain0001!.version === 2, '现行基线应取最高版本 v2')
  assert(judgeLevel(42, rain0001) === '警戒级', '42mm/h 应判警戒级')
  assert(judgeLevel(15, rain0001) === '注意级', '15 应判注意级')
  assert(judgeLevel(2, rain0001) === null, '2 不达标')
  assert(judgeLevel(null, rain0001) === null, '缺测不判')

  // 3. 参数非法逐条定位。
  const bad = previewBatch([
    {
      hazardCode: 'HAZA-0001',
      monitorType: '雨量',
      notice: '99',
      warning: '-1',
      alert: '10',
      effectiveTime: '',
      setter: '',
    },
    {
      hazardCode: 'HAZA-0001',
      monitorType: '不存在的类型',
      notice: '10',
      warning: '20',
      alert: '5',
      effectiveTime: '2026-10-06 00:00',
      setter: '测试员',
    },
  ])
  assert(bad.issues.length >= 4, `非法参数应逐条列出，实际 ${bad.issues.length}`)
  assert(bad.issues.some((i) => i.field === '警示级阈值' && i.index === 0), '警示级非法要定位到条目')
  assert(bad.issues.some((i) => i.field === '监测类型' && i.index === 1), '非法监测类型要定位到条目')
  assert(bad.issues.some((i) => i.field === '阈值' && i.index === 1), '递增关系非法要标出')
  assert(!bad.canPublish, '有非法参数不可发布')

  // 4. 同键重复 = 阻断冲突。
  const dup = previewBatch([
    { hazardCode: 'HAZA-0001', monitorType: '雨量', notice: '8', warning: '20', alert: '35', effectiveTime: '2026-10-06 00:00', setter: '测试员' },
    { hazardCode: 'HAZA-0001', monitorType: '雨量', notice: '9', warning: '21', alert: '36', effectiveTime: '2026-10-06 00:00', setter: '测试员' },
  ])
  assert(dup.conflicts.some((c) => c.kind === 'duplicate' && c.severity === 'block'), '重复条目阻断')

  // 5. 已废止 = confirm；无基线 = tip；影响面试算等级变化。
  const trial = previewBatch([
    { hazardCode: 'HAZA-0003', monitorType: '雨量', notice: '3', warning: '8', alert: '20', effectiveTime: '2026-10-06 00:00', setter: '测试员' },
    { hazardCode: 'HAZA-0001', monitorType: '雨量', notice: '8', warning: '20', alert: '35', effectiveTime: '2026-10-06 00:00', setter: '测试员' },
    { hazardCode: 'HAZA-0001', monitorType: '倾斜', notice: '0.6', warning: '1.2', alert: '1.8', effectiveTime: '2026-10-06 00:00', setter: '测试员' },
    { hazardCode: 'HAZA-0002', monitorType: '雨量', notice: '12', warning: '25', alert: '40', effectiveTime: '2026-10-06 00:00', setter: '测试员' },
    { hazardCode: 'HAZA-0002', monitorType: '倾斜', notice: '0.6', warning: '1.2', alert: '1.8', effectiveTime: '2026-10-06 00:00', setter: '测试员' },
  ])
  assert(trial.canPublish, '合法参数+无阻断应可发布')
  assert(trial.conflicts.some((c) => c.kind === 'currentObsolete'), 'HAZA-0003 雨量应检出已废止')
  assert(!trial.conflicts.some((c) => c.kind === 'noBaseline'), 'HAZA-0003 有废止行，不报 noBaseline')
  // RAIN-0006 HAZA-0003 雨强 5：新阈值 3/8/20 → 注意级（原无基线 → 未判）。
  const r6 = trial.impact.rainRows.find((r) => r.recordCode === 'RAIN-0006')
  assert(r6 && r6.beforeLevel === null && r6.afterLevel === '注意级' && r6.changed, '无基线点应首判')
  // HAZA-0001 雨量换 8/20/35：RAIN-0001(15) 原注意级(10) → 新注意级(8) 不变；
  // RAIN-0002(42) 新旧都为警戒级；RAIN-0003(2) 均不达标。
  const changedRain = trial.impact.rainRows.filter((r) => r.changed).map((r) => r.recordCode)
  assert(!changedRain.includes('RAIN-0001'), `RAIN-0001(15) 新旧均为注意级；实际变化集 ${changedRain}`)
  assert(!changedRain.includes('RAIN-0002'), 'RAIN-0002(42) 新旧都为警戒级，不变化')
  const r2 = trial.impact.rainRows.find((r) => r.recordCode === 'RAIN-0002')
  assert(r2 && r2.beforeLevel === '警戒级' && r2.afterLevel === '警戒级', '42 在新旧阈值下都警戒')
  // HAZA-0002 雨量换 12/25/40：RAIN-0004(28) 原注意级(旧阈值15/30) → 新警示级(25/40)，升级重判。
  const r4 = trial.impact.rainRows.find((r) => r.recordCode === 'RAIN-0004')
  assert(r4 && r4.beforeLevel === '注意级' && r4.afterLevel === '警示级' && r4.changed, 'RAIN-0004 应升为警示级')
  // HAZA-0002 倾斜换 0.6/0.9/1.5：TILT-0001(0.4) 不达标；TILT-0004(1.1) 警示级→注意级。
  const t1 = trial.impact.tiltRows.find((r) => r.recordCode === 'TILT-0001')
  assert(t1 && t1.afterLevel === null, 'TILT-0001(0.4) 新基线下不达标')
  assert(t1 && t1.beforeLevel === '注意级' && t1.changed, 'TILT-0001 应由注意级降为不达标')
  const t4 = trial.impact.tiltRows.find((r) => r.recordCode === 'TILT-0004')
  assert(t4 && t4.beforeLevel === '警示级' && t4.afterLevel === '注意级' && t4.changed, 'TILT-0004 应降为注意级')
  assert(trial.impact.unreadableRows >= 2, 'RAIN-0005 与 TILT-0005 缺测应计入不可读')

  // 6. 整批发布：新版本 + 台账换基线，一事务成功。
  const beforeThCount = listRows('threshold').length
  const result = publishBatch(
    [
      { hazardCode: 'HAZA-0001', monitorType: '雨量', notice: '8', warning: '20', alert: '35', effectiveTime: '2026-10-06 00:00', setter: '测试员' },
      { hazardCode: 'HAZA-0003', monitorType: '雨量', notice: '3', warning: '8', alert: '20', effectiveTime: '2026-10-06 00:00', setter: '测试员' },
    ],
    { operator: '测试员' },
  )
  assert(result.ok, result.message)
  assert(listRows('threshold').length === beforeThCount + 2, '应新增 2 个版本行')
  const newBase = readBaseline({ hazardCode: 'HAZA-0001', monitorType: '雨量' })
  assert(newBase!.version === 3 && newBase!.thresholdCode === 'THRE-0001', '同键沿用编号升到 v3')
  assert(newBase!.levels['注意级'] === 8, '新基线值生效')
  const rainRows = listRows('rain_gauge')
  const stamped = rainRows.filter((r) => String(r['隐患点编号']) === 'HAZA-0001')
  assert(stamped.every((r) => r['判定基线'] === 'THRE-0001' && r['基线版本'] === 3), '雨量台账全部换到 v3')
  const r1 = rainRows.find((r) => r['记录编号'] === 'RAIN-0001')
  assert(r1!['判定等级'] === '注意级', '15 对新 8/20/35 判注意级')
  const r3 = rainRows.find((r) => r['记录编号'] === 'RAIN-0003')
  assert(r3!['判定等级'] === '', '2 不达标应清空等级')
  // 倾斜台账不应被动。
  const tiltUntouched = listRows('tilt').find((r) => r['记录编号'] === 'TILT-0001')
  assert(tiltUntouched!['基线版本'] === 1, '未选监测类型的台账基线不动')

  // 7. 重复发布幂等：不新增版本。
  const batchNo = result.batch!.batchNo
  const beforeCount2 = listRows('threshold').length
  const again = publishBatch(
    [
      { hazardCode: 'HAZA-0001', monitorType: '雨量', notice: '99', warning: '100', alert: '101', effectiveTime: '2026-10-07 00:00', setter: '测试员' },
    ],
    { batchNo, operator: '测试员' },
  )
  assert(again.ok, '重复发布应返回成功(幂等)')
  assert(listRows('threshold').length === beforeCount2, '重复发布不得多出一套版本')
  assert(readBaseline({ hazardCode: 'HAZA-0001', monitorType: '雨量' })!.version === 3, '基线仍为 v3')

  // 8. 事务回退：非法参数绝不落盘任何模块（prepare 在写盘前拦截）。
  const beforeAll = {
    threshold: listRows('threshold').length,
    rain_gauge: listRows('rain_gauge').length,
  }
  const fail = publishBatch(
    [{ hazardCode: 'HAZA-0002', monitorType: '雨量', notice: '50', warning: '10', alert: '5', effectiveTime: '2026-10-08 00:00', setter: '测试员' }],
    { operator: '测试员' },
  )
  assert(!fail.ok && (fail.issues?.length ?? 0) > 0, '递增非法应拦截')
  assert(listRows('threshold').length === beforeAll.threshold, '失败不写阈值')
  assert(listRows('rain_gauge').length === beforeAll.rain_gauge, '失败不写台账')

  // 9. 模拟写入中途异常 → commitSnapshot 全量回退。
  // 提交顺序为 threshold → rain_gauge → tilt；让第 2 次落盘（雨量台账）失败。
  const rainSnapshot = JSON.stringify(listRows('rain_gauge'))
  const thresholdSnapshot = JSON.stringify(listRows('threshold'))
  ;(globalThis as any).__setItemCalls = 0
  ;(globalThis as any).__failSetItemAt = 2
  const txFail = publishBatch(
    [{ hazardCode: 'HAZA-0002', monitorType: '雨量', notice: '12', warning: '25', alert: '40', effectiveTime: '2026-10-08 00:00', setter: '测试员' }],
    { operator: '测试员' },
  )
  ;(globalThis as any).__failSetItemAt = 0
  assert(!txFail.ok, '事务中途失败应返回失败')
  assert(JSON.stringify(listRows('rain_gauge')) === rainSnapshot, '台账应整体回退到事务前')
  assert(JSON.stringify(listRows('threshold')) === thresholdSnapshot, '阈值也应整体回退')
  const haza02 = readBaseline({ hazardCode: 'HAZA-0002', monitorType: '雨量' })
  assert(haza02!.version === 1 && haza02!.levels['注意级'] === 15, '回退后基线仍为 v1 原值')

  // 10. 草稿可存非法参数并续编辑。
  const draft = saveDraft(
    [{ hazardCode: 'HAZA-0002', monitorType: '雨量', notice: '', warning: '', alert: '', effectiveTime: '', setter: '' }],
    { operator: '测试员' },
  )
  assert(draft.status === '草稿' && listBatches().some((b) => b.batchNo === draft.batchNo), '草稿落盘')

  console.log('全部冒烟断言通过 ✅')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
