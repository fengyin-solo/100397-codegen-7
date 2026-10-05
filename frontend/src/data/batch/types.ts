/** 预警阈值批量试算台的领域类型：阈值读取、预警判定、雨量/倾斜取数链都围绕这组结构转。 */

// 预警的三个等级，判定时按 注意 < 警示 < 警戒 递增比较。
export type AlarmLevel = '注意级' | '警示级' | '警戒级'

export const LEVELS: AlarmLevel[] = ['注意级', '警示级', '警戒级']

// 监测类型与台账模块的取数映射：阈值发布后要顺着这张表去换别的业务面的判定基线。
export type MonitorKind = '雨量' | '倾斜'

export type KindChain = {
  kind: MonitorKind
  moduleKey: 'rain_gauge' | 'tilt'
  ledgerName: string
  valueField: string
  valueLabel: string
  valueUnit: string
  // 判定用的三级阈值字段名，阈值台账与候选参数都按这套字段存。
  levelFields: Record<AlarmLevel, string>
}

export const KIND_CHAINS: KindChain[] = [
  {
    kind: '雨量',
    moduleKey: 'rain_gauge',
    ledgerName: '雨量监测',
    valueField: '小时最大雨强',
    valueLabel: '小时最大雨强',
    valueUnit: 'mm/h',
    levelFields: { 注意级: '注意级阈值', 警示级: '警示级阈值', 警戒级: '警戒级阈值' },
  },
  {
    kind: '倾斜',
    moduleKey: 'tilt',
    ledgerName: '倾斜监测',
    valueField: '倾斜角度',
    valueLabel: '倾斜角度',
    valueUnit: '°',
    levelFields: { 注意级: '注意级阈值', 警示级: '警示级阈值', 警戒级: '警戒级阈值' },
  },
]

export const KIND_BY_NAME: Map<string, KindChain> = new Map(KIND_CHAINS.map((item) => [item.kind, item]))

// 阈值业务键：同一隐患点 + 同一监测类型只允许一条现行基线，版本沿这个键往下叠。
export type ThresholdKey = {
  hazardCode: string
  monitorType: string
}

export type Baseline = ThresholdKey & {
  rowId: number
  thresholdCode: string
  version: number
  levels: Record<AlarmLevel, number>
  setter: string
  status: string
  setTime: string
  effectiveTime: string
}

// 台账上挂的判定基线信息：发布换基线后，雨量/倾斜业务面读到的就是新版本。
export type LedgerBaselineStamp = {
  thresholdCode: string
  version: number
  effectiveTime: string
}

// 试算台录入的一条候选参数。
export type BatchCandidateInput = ThresholdKey & {
  notice: string
  warning: string
  alert: string
  effectiveTime: string
  setter: string
}

export type BatchCandidate = ThresholdKey & {
  notice: number
  warning: number
  alert: number
  effectiveTime: string
  setter: string
}

// 单条候选上的参数级错误：任一参数非法都要指出具体条目。
export type CandidateIssue = {
  index: number
  hazardCode: string
  monitorType: string
  field: string
  message: string
}

// 版本冲突：候选参数与现行配置打架时逐条列出，按预设规则给出处理方式。
export type ConflictKind =
  | 'duplicate' // 同一批次里同一隐患点+监测类型出现多条
  | 'baselineChanged' // 试算期间现行基线版本发生漂移
  | 'draftExists' // 该键已有未发布草稿，本次保存会覆盖续存
  | 'currentObsolete' // 现行配置已废止，发布将作为新版本重建基线
  | 'noBaseline' // 该键还没有任何配置，发布将首次建立基线

export type Conflict = ThresholdKey & {
  kind: ConflictKind
  detail: string
  rule: string
  severity: 'block' | 'confirm' | 'tip'
}

// 取数链上的一条观测记录及试算前后的判定结果。
export type ImpactRow = {
  moduleKey: string
  rowId: number
  recordCode: string
  hazardCode: string
  monitorType: string
  valueField: string
  rawValue: string
  numericValue: number | null
  beforeLevel: AlarmLevel | null
  afterLevel: AlarmLevel | null
  changed: boolean
}

export type ImpactSummary = {
  rainRows: ImpactRow[]
  tiltRows: ImpactRow[]
  affectedHazards: number
  affectedRows: number
  changedRows: number
  unreadableRows: number
}

export type TrialResult = {
  candidates: BatchCandidate[]
  issues: CandidateIssue[]
  conflicts: Conflict[]
  baselines: Map<string, Baseline>
  impact: ImpactSummary
  canPublish: boolean
}

// 草稿与已发布批次都落在这张结构里，批次号幂等：重复发布不得多出一套版本。
export type BatchRecord = {
  batchNo: string
  operator: string
  createdAt: string
  updatedAt: string
  status: '草稿' | '已发布'
  candidates: BatchCandidateInput[]
  publishedAt?: string
  publishedVersions?: { thresholdCode: string; version: number }[]
  // 试算快照里记录的现行版本号，发布时据此判断基线是否漂移。
  baselineSnapshot?: { key: string; version: number }[]
}

export type PublishResult = {
  ok: boolean
  message: string
  batch?: BatchRecord
  issues?: CandidateIssue[]
  conflicts?: Conflict[]
}
