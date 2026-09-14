// 订阅消息模板 ID 集中管理（与 cloudfunctions/_lib/index.js 的 TPL 一一对应）
// 后端用它发、前端用它请求用户授权，改动时只改这里一处。
const TPLS = {
  reserveSuccess: 'ShNSAxZvFsDgyZhFfi3OTbofXCzjsM5P1-sSD8ZU2e4', // 预约成功（顾客）
  reserveCancel: 'Y1VIDe6Y_DiQqzE_FaaBzvNyD2nErGogF5pCbLed_u8', // 预约取消（顾客）
  reminder: 'OTbjHkCiDnS2a5r0-6AIf2ze41-M2flVKAKbt6LWe6c',     // 开场前提醒（顾客）
  adminNew: 'AJ8iCZgYFaNoSmwmrwwivnRTnJ3BvFu5sOeg4Wa-3aM',      // 新预约提醒（管理员）
  adminCancel: 'TpTXSsqC4i8F_GtN_boeKh4TXjVI-1rXUwA01AIdO5Q',   // 预约取消提醒（管理员）
  adminReview: 'UQJ5AfBWVUTQO-upC-3_W-UeDu_BgPPGoyj11Ei5Py8',   // 待审核提醒（管理员）
  reminderEnd: '6-dCpVBL6RL0IOjnzVZfpK_2apG2hwSpv01BrKvvRzM',  // 结束提醒（顾客，仅预订人）· 模板21337「预约过期通知」
  dayBefore: 'rQEgm5zUep1S9oGeYKYUEawhPK3rs48EQwNncx0HP04'     // 前一天提醒（顾客，每天 dayBeforeAt 推送次日预约）
}

// ===== 顾客侧通知类型（单一真相源）=====
// 各展示面（确认页勾选弹窗 / 我的-通知偏好 / 管理端通知配置）一律从这里取类型与文案。
// ⚠️ key 必须与后端 _lib 的 SUB_KEYS 一致：后端按 key 判定是否发送（subs[key] !== false）。
// ⚠️ 数组顺序 = 展示顺序；提交时「实际申请哪几个」由 notifyPlanOf 按预约时间轴动态裁剪（≤3）。
const CUSTOMER_SUBS = [
  {
    key: 'reserveSuccess',
    tmplId: TPLS.reserveSuccess,
    label: '预约确认',
    desc: '提交预约后，第一时间收到「已为您留座」的确认通知'
  },
  {
    key: 'dayBefore',
    tmplId: TPLS.dayBefore,
    label: '前一天提醒',
    desc: '预约前一天提醒您次日的入场时间（具体时刻由店家设定）'
  },
  {
    key: 'reminder',
    tmplId: TPLS.reminder,
    label: '开场前提醒',
    desc: '场次开始前提醒您出发'
  },
  {
    key: 'reminderEnd',
    tmplId: TPLS.reminderEnd,
    label: '结束提醒',
    desc: '场次结束后收到「感谢到来」的通知'
  },
  {
    key: 'reserveCancel',
    tmplId: TPLS.reserveCancel,
    label: '预约取消',
    desc: '预约被取消时收到通知（您自行取消或店铺取消）'
  }
]

// 管理员侧通知类型（管理端在「通知配置」中授权，与顾客侧互不干扰）
const ADMIN_SUBS = [
  { key: 'adminNew', tmplId: TPLS.adminNew, label: '新预约提醒', desc: '有顾客提交新预约时提醒管理员' },
  { key: 'adminCancel', tmplId: TPLS.adminCancel, label: '预约取消提醒', desc: '有预约被取消时提醒管理员' },
  { key: 'adminReview', tmplId: TPLS.adminReview, label: '待审核提醒', desc: '有预约待审核时提醒管理员' }
]

// 顾客侧 / 管理员侧需要授权的模板 ID 列表（由上面的定义派生，保证永不走样）
const BOOKER_TPLS = CUSTOMER_SUBS.map(s => s.tmplId)
const ADMIN_TPLS = ADMIN_SUBS.map(s => s.tmplId)

// 顾客侧订阅 key 列表（与后端 _lib 的 SUB_KEYS 一致）
const CUSTOMER_SUB_KEYS = CUSTOMER_SUBS.map(s => s.key)

// 默认订阅状态：缺省全部订阅（与后端 normalizeSubs 一致）
function defaultSubs() {
  const o = {}
  CUSTOMER_SUB_KEYS.forEach(k => { o[k] = true })
  return o
}

// 规整任意输入为完整的顾客订阅对象：未显式置 false 一律视为已订阅（缺省开）
function normalizeSubs(input) {
  const src = input && typeof input === 'object' ? input : {}
  const o = {}
  CUSTOMER_SUB_KEYS.forEach(k => { o[k] = src[k] !== false })
  return o
}

// 由勾选状态取出全部已勾选的模板 ID（未按时间轴裁剪；一般用 tmplIdsOfPlan）
function tmplIdsOf(subs) {
  return CUSTOMER_SUBS.filter(s => subs && subs[s.key] !== false).map(s => s.tmplId)
}

// ===== 通知计划（按预约时间轴动态裁剪）=====
// 与后端 _lib.notifyPlan 同一规则的前端镜像：notifyPlanOf 返回「完整未来适用集合」（不截断，与后端一致）。
// 真正做「≤3 分配」的是 tmplIdsOfPlan（提交弹窗授权集），保证只弹 1 次窗。
// ⚠️ 规则必须与 cloudfunctions/_lib/index.js 的 notifyPlan 保持同步。

// 通知时间窗配置默认值（实际值由 getProject 返回的 notifyCfg 下发；与后端 notifyWindowCfg 一致）
const NOTIFY_CFG_DEFAULT = {
  dayBeforeAt: '17:30',
  dayBeforeWindow: 180,
  approachingWhen: 'before',
  approachingOffset: 60,
  expiredWhen: 'after',
  expiredOffset: 5
}

// 与后端 notifyWindowCfg 同源的归一化
function normalizeNotifyCfg(cfg) {
  const s = cfg && typeof cfg === 'object' ? cfg : {}
  return {
    dayBeforeAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.dayBeforeAt || '')) ? s.dayBeforeAt : NOTIFY_CFG_DEFAULT.dayBeforeAt,
    dayBeforeWindow: typeof s.dayBeforeWindow === 'number' && s.dayBeforeWindow >= 0 ? s.dayBeforeWindow : NOTIFY_CFG_DEFAULT.dayBeforeWindow,
    approachingWhen: s.approachingWhen === 'after' ? 'after' : 'before',
    approachingOffset: typeof s.approachingOffset === 'number' && s.approachingOffset >= 0 ? s.approachingOffset : NOTIFY_CFG_DEFAULT.approachingOffset,
    expiredWhen: s.expiredWhen === 'before' ? 'before' : 'after',
    expiredOffset: typeof s.expiredOffset === 'number' && s.expiredOffset >= 0 ? s.expiredOffset : NOTIFY_CFG_DEFAULT.expiredOffset
  }
}

// 'YYYY-MM-DD' ± n 天
function shiftDate(dateStr, n) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number)
  if (!y || !m || !d) return ''
  const t = new Date(Date.UTC(y, m - 1, d + (n || 0)))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

// 北京时区 'YYYY-MM-DD' + 'HH:mm' → 时间戳（毫秒）。
// ⚠️ 不能写 `new Date('2026-09-13 19:00')`：iOS 对该格式返回 Invalid Date，
//    且设备时区不定。统一用 Date.UTC(...) − 8h 还原真实时刻（与后端 bjTs 同源）。
function bjTs(dateStr, hm) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number)
  if (!y || !m || !d) return NaN
  const [hh, mm] = String(hm || '23:59').split(':').map(Number)
  return Date.UTC(y, m - 1, d, isNaN(hh) ? 23 : hh, isNaN(mm) ? 59 : mm) - 8 * 3600 * 1000
}

// 本次预约应启用的时间轴通知：返回 4 键布尔对象（恒含全部键，完整未来适用集合，不截断）。
// 「预约取消」不在此列——它在用户点「取消预约」时即时申请授权（见 mine.js）。
// ⚠️ 与后端 _lib.notifyPlan 同源：只算「哪些时间轴提醒仍在未来」，不做 ≤3 限制。
function notifyPlanOf(reservation, cfg, nowTs) {
  const now = nowTs || Date.now()
  const f = normalizeNotifyCfg(cfg)
  const r = reservation || {}
  const plan = { reserveSuccess: true, dayBefore: false, reminder: false, reminderEnd: false }

  const startTs = bjTs(r.date, r.sessionStart)
  const endTs = bjTs(r.date, r.sessionEnd)
  const dbFire = bjTs(shiftDate(r.date, -1), f.dayBeforeAt)
  const dbEnd = isNaN(dbFire) ? NaN : dbFire + f.dayBeforeWindow * 60000
  const remFire = isNaN(startTs) ? NaN
    : (f.approachingWhen === 'after' ? startTs + f.approachingOffset * 60000 : startTs - f.approachingOffset * 60000)
  const endFire = isNaN(endTs) ? NaN
    : (f.expiredWhen === 'before' ? endTs - f.expiredOffset * 60000 : endTs + f.expiredOffset * 60000)

  if (!isNaN(dbEnd) && now < dbEnd) plan.dayBefore = true
  if (!isNaN(remFire) && now < remFire) plan.reminder = true
  if (!isNaN(endFire) && now < endFire) plan.reminderEnd = true

  return plan
}

// 由「计划」构造【提交瞬间微信授权弹窗】要申请的模板 ID 集合（≤3，恰好满足微信单次上限）。
//
// 分配规则（与需求设计文档 3.2 一致，恒为 1 次弹窗）：
//   1) 预约成功 = 必含（占用 1 槽）；
//   2) 时间轴类（前一天/开场前/结束）按「仍在未来」过滤，且最多占 2 槽（优先级 前一天 > 开场前 > 结束）；
//      → 远期单（前一天+开场前+结束都未来）会舍弃「结束提醒」这一槽，改由短信兜底（见 _lib.shouldSkipSms）；
//   3) 若合计 < 3（即时间轴类不足 2 个，典型为「迟到单」「已过场次」档），顺带补入「取消」，
//      使取消在提交时即拿到微信授权，减少后续取消时只能走短信的概率。
// 未勾选（subs[key]===false）的项不申请；但后端仍会按短信兜底铁律补发。
// ⚠️ 规则必须与 cloudfunctions/_lib/index.js 的 notifyPlan 保持同步（前者算完整计划，本函数做 ≤3 分配）。
function tmplIdsOfPlan(plan, subs) {
  // 1) 预约成功恒在
  const keys = ['reserveSuccess']
  // 2) 时间轴类：仍在未来的，按优先级取前 2 个
  const timeAxis = ['dayBefore', 'reminder', 'reminderEnd'].filter(k => plan && plan[k] === true)
  keys.push(...timeAxis.slice(0, 2))
  // 3) 还有空位 → 顺带补「取消」（最大化微信授权覆盖、减少短信兜底）
  if (keys.length < 3 && !keys.includes('reserveCancel')) keys.push('reserveCancel')
  // 映射到模板 ID，并尊重用户长期偏好（subs）
  return CUSTOMER_SUBS
    .filter(s => keys.includes(s.key) && (!subs || subs[s.key] !== false))
    .map(s => s.tmplId)
}

module.exports = {
  TPLS, BOOKER_TPLS, ADMIN_TPLS,
  CUSTOMER_SUBS, CUSTOMER_SUB_KEYS, ADMIN_SUBS,
  defaultSubs, normalizeSubs, tmplIdsOf,
  NOTIFY_CFG_DEFAULT, normalizeNotifyCfg, notifyPlanOf, tmplIdsOfPlan, bjTs, shiftDate
}
