// cloudfunctions/_lib/index.js — 共享库（部署时由脚本复制到每个云函数目录为 lib.js）
// 提供：云初始化、数据库引用、响应包装、角色判定、日期工具、订阅消息占位。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { logNotify } = require('./notifyLog')   // 通知流水打点（数据分析「订阅通知」数量统计的数据源）

const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

const COL = {
  homepage: 'config_homepage',
  projects: 'projects',
  schedules: 'schedules',
  reservations: 'reservations',
  admins: 'admins',
  users: 'users',
  stats: 'stats_daily',
  products: 'products',
  reviews: 'reviews'
}

// 订阅消息模板（已申请真实 ID；占位时的 TPL_ID_* 会被 sendSubscribe 自动跳过）
const TPL = {
  reserveSuccess: 'ShNSAxZvFsDgyZhFfi3OTbofXCzjsM5P1-sSD8ZU2e4',   // 预约成功（顾客）
  reserveCancel: 'Y1VIDe6Y_DiQqzE_FaaBzvNyD2nErGogF5pCbLed_u8',     // 预约取消（顾客）
  reminder: 'OTbjHkCiDnS2a5r0-6AIf2ze41-M2flVKAKbt6LWe6c',         // 开场前提醒（顾客）
  adminNew: 'AJ8iCZgYFaNoSmwmrwwivnRTnJ3BvFu5sOeg4Wa-3aM',          // 新预约提醒（管理员 owner+manager）
  adminCancel: 'TpTXSsqC4i8F_GtN_boeKh4TXjVI-1rXUwA01AIdO5Q',       // 预约取消提醒（管理员 owner+manager）
  adminReview: 'UQJ5AfBWVUTQO-upC-3_W-UeDu_BgPPGoyj11Ei5Py8',       // 待审核提醒（管理员 owner+manager）
  reminderEnd: '6-dCpVBL6RL0IOjnzVZfpK_2apG2hwSpv01BrKvvRzM',    // 结束提醒（顾客，仅预订人）· 模板21337「预约过期通知」
  dayBefore: 'rQEgm5zUep1S9oGeYKYUEawhPK3rs48EQwNncx0HP04'        // 前一天提醒（顾客，每天 17:30 推送次日预约）
}

// 服务号「订阅通知」模板 ID（公众号后台 → 订阅通知 申请，非已废弃的「模板消息」）。
// ⚠️ 下面 4 个 ID 仍是【模板消息】旧 ID（已于 2023-10-01 废弃，45103 失效），待用户从「订阅通知」申请到新 ID 后替换！
// 字段键（thing*/number*/const*）必须与用户后台「订阅通知」模板实际关键词一致；data 构造在各触发函数里，替换 ID 时需同步核对字段。
const MP_TPL = {
  adminNew: 'JQI4jXsKyQAa2zU_kbKuhrXPV4kQHW_n_6hPVUhoLIQ',      // TODO(订阅通知) 待替换：餐位被预订提醒（管理员 owner+manager）· 免审下单成功
  reserveSuccess: '63vHJHcLMU2tW27b2MdwAmxp7LMwTWe6oRB4O_PcXYs', // TODO(订阅通知) 待替换：订座结果提醒·成功（顾客）· 免审成功 / 审核通过
  reserveCancel: '63vHJHcLMU2tW27b2MdwAmxp7LMwTWe6oRB4O_PcXYs',  // TODO(订阅通知) 待替换：订座结果提醒·取消（顾客+管理员）· 与原同一模板 const 区分
  adminReview: 'eBa1lSsI5HY37Funet_Hiz4QuY2W6kQanSDV94aPgxA'     // TODO(订阅通知) 待替换：收到新订餐订单通知（管理员 owner+manager）· 待审下单成功
}

// 店铺默认名（以店铺名义发订阅/短信）。优先读 config 集合文档 store.name，回退此常量。
const DEFAULT_STORE_NAME = '二曜路8号咖啡和清酒'

function ok(data) { return { code: 0, message: 'ok', data } }
function fail(message, code = -1) { return { code, message, data: null } }

function wxCtx() { return cloud.getWXContext() }

// 解析调用者角色；无记录返回 { role:'none' }
async function getRole(openid) {
  if (!openid) return { role: 'none', openid: '' }
  const r = await db.collection(COL.admins).where({ openid }).get()
  if (r.data.length) return r.data[0]
  return { role: 'none', openid }
}

// 首个进入者自动成为 owner（仅当 admins 中无 owner 时）
async function ensureOwner(openid) {
  if (!openid) return null
  const owners = await db.collection(COL.admins).where({ role: 'owner' }).get()
  if (owners.data.length) return null
  await db.collection(COL.admins).add({
    data: { openid, role: 'owner', note: '初始店主', inviterOpenid: '', createdAt: Date.now() }
  })
  return 'owner'
}

// 北京时间的日历日期（YYYY-MM-DD）。
// ⚠️ 云函数容器时区是 UTC，而系统所有日期均为「北京时间」字符串；
//    用本地年月日方法（getFullYear/getMonth/getDate）在 UTC 容器下，北京时间 0–8 点会取到前一天。
//    统一做法：把真实时刻 +8h 后「按 UTC 取出年月日」即等于北京时间日历（与 bjTs 同一套时区约定）。
function bjYmd(d) {
  const t = (d instanceof Date) ? d : new Date()
  const u = new Date(t.getTime() + 8 * 3600 * 1000)
  return `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, '0')}-${String(u.getUTCDate()).padStart(2, '0')}`
}
// 北京时间今天 + n 天（n 可为负）：在「真实时刻 +n 天」上取北京日历，避免本地时区错天。
function bjAddDays(n) {
  return bjYmd(new Date(Date.now() + (Number(n) || 0) * 86400000))
}

// 当前日期 YYYY-MM-DD（Asia/Shanghai）—— 直接委托 bjYmd，确保 UTC 容器下也不会错天
function ymd(d) { return bjYmd(d) }
// 今天 + n 天 —— 委托 bjAddDays
function addDays(n) { return bjAddDays(n) }

// 北京时间 'YYYY-MM-DD' + 'HH:mm' → 真实时间戳（毫秒）。
// ⚠️ 云函数容器时区是 **UTC**，而库里 date / sessionStart / sessionEnd 存的是**北京时间**字符串。
//    因此绝不能用 `new Date('2026-09-11 20:00')`（按容器本地时区解析 → UTC 下等于北京 09-12 04:00），
//    那会让所有「结束/过期」判定整体延后 8 小时。统一用 Date.UTC(...) − 8h 还原真实时刻。
// 解析失败返回 NaN，调用方需保守处理（不要当成已过期）。
function bjTs(dateStr, hm) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number)
  if (!y || !m || !d) return NaN
  const [hh, mm] = String(hm || '23:59').split(':').map(Number)
  return Date.UTC(y, m - 1, d, isNaN(hh) ? 23 : hh, isNaN(mm) ? 59 : mm) - 8 * 3600 * 1000
}

// 预约的有效状态（五态）：cancelled / completed / expired / pending / confirmed
// 场次结束时刻（北京时间）已过 → expired。共享库同源实现，避免各函数各写一份走样。
function effStatus(r, nowTs) {
  if (!r) return 'pending'
  if (r.status === 'cancelled') return 'cancelled'
  if (r.status === 'completed') return 'completed'
  const end = bjTs(r.date, r.sessionEnd)
  if (!isNaN(end) && end < (nowTs || Date.now())) return 'expired'
  return r.status // pending | confirmed
}

// 友好短日期：YYYY-MM-DD -> M月D日（如 8月20日），用于订阅/短信文案
function monthDay(ymdStr) {
  const [y, m, d] = String(ymdStr || '').split('-').map(Number)
  if (!m || !d) return ymdStr || ''
  return `${m}月${d}日`
}

// 日历/列表日期标签：YYYY-MM-DD -> MM/DD（如 09/07），顾客端日历与项目卡片用
function monthDaySlash(ymdStr) {
  const [y, m, d] = String(ymdStr || '').split('-').map(Number)
  if (!m || !d) return ymdStr || ''
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`
}

// 读取店铺名（以店铺名义发消息）。优先 config 集合文档 store.name，回退默认常量。
async function getStoreName(db) {
  try {
    const r = await db.collection('config').doc('store').get()
    if (r && r.data && r.data.name) return r.data.name
  } catch (e) { /* 文档不存在时用默认名 */ }
  return DEFAULT_STORE_NAME
}

// 发送订阅消息；返回结构化结果（不再静默吞，便于排查 43101/47003/47004）
async function sendSubscribe(o) {
  const { openid, templateId, data, page } = o || {}
  // 场景 / 归口可由调用方显式传入；没传就按模板 ID 反查（TPL 里已登记全部小程序订阅模板）
  const scene = (o && o.scene) || sceneOfTemplate(templateId)
  const meta = { channel: 'wx', scene, audience: (o && o.audience) || '', templateId, openid, reservationId: (o && o.reservationId) || '' }
  if (!openid || !templateId || templateId.indexOf('TPL_ID_') === 0) {
    // 未真正发送（模板未配置）⇒ 不写流水：统计口径只认「实际触达尝试」
    return { ok: false, skipped: true, reason: 'template not configured', openid, templateId }
  }
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      data,
      page: page || 'pages/index/index'
    })
    await logNotify(db, { ...meta, ok: true })
    return { ok: true, openid, templateId }
  } catch (e) {
    // 关键错误码：43101=用户未授权订阅模板；47003=字段值/关键字非法；47004=模板不存在
    const errCode = e && (e.errCode !== undefined ? e.errCode : e.code)
    const errMsg = (e && e.message) ? e.message : String(e)
    console.warn('[subscribe] send failed:', errCode, errMsg, 'tmpl=', templateId)
    await logNotify(db, { ...meta, ok: false, errCode, errMsg })
    return { ok: false, openid, templateId, errCode, errMsg }
  }
}

// 模板 ID → 场景键（供通知流水归类；反查不到就留空，不影响发送）
function sceneOfTemplate(templateId) {
  if (!templateId) return ''
  for (const k of Object.keys(TPL)) if (TPL[k] === templateId) return k
  return ''
}

// 读取「订阅消息开关」配置（config.subscribe 文档）。缺省视为全部开启。
async function loadSubscribeSwitch(db) {
  try {
    const r = await db.collection('config').doc('subscribe').get()
    return (r && r.data) || {}
  } catch (e) { return {} }
}
// 单个订阅模板是否允许发送：config.subscribe[key] !== false 视为开（缺省开）
function subOn(subCfg, key) { return subCfg ? (subCfg[key] !== false) : true }

// ===== 统一用户订阅记录（顾客侧）=====
// 顾客在确认页以「勾选列表一次性收集所有通知类型订阅」，提交时把勾选结果存进 users.subscriptions。
// 所有顾客侧触发逻辑（预约成功/取消/开场前提醒/结束提醒/前一天提醒）统一读取该记录：
//   subs[key] !== false 视为已订阅（缺省开）。
// 全局开关 subOn 与用户记录 subbedOf 是「与」关系——二者皆开才真正发送。
// 顾客侧通知模板共 5 类；「时间轴上实际会触发的」在任一场景下都不超过 3 条，
// 由 notifyPlan() 按预约时间轴动态裁剪（见下方「通知计划」段）。
//    改这里即全链路收敛（normalizeSubs / subbedOf / loadUserSubs 均由 SUB_KEYS 驱动）。
const SUB_KEYS = ['reserveSuccess', 'dayBefore', 'reminder', 'reminderEnd', 'reserveCancel']

// 把任意输入规整为 5 个已知键的布尔对象；未显式置 false 一律视为已订阅（缺省开）。
function normalizeSubs(s) {
  const out = {}
  for (const k of SUB_KEYS) out[k] = !!(s && s[k] !== false)
  return out
}

// 单个顾客订阅是否生效：subs[key] !== false 视为已订阅（缺省开）；
// 记录缺失（null/undefined）也视为已订阅，保证「读不到记录」时不会误拦通知。
function subbedOf(subs, key) { return subs ? (subs[key] !== false) : true }

// 读取并缓存某顾客的订阅记录（users.subscriptions）。cache 为可选 Map<openid, subs>，
// 供 remindReservation 循环内避免重复 DB 读取。读取失败回退为「全部订阅」默认值。
async function loadUserSubs(openid, cache) {
  if (!openid) return normalizeSubs({})
  if (cache && cache.has(openid)) return cache.get(openid)
  let subs = normalizeSubs({})
  try {
    const r = await db.collection(COL.users).doc(openid).get()
    if (r && r.data) subs = normalizeSubs(r.data.subscriptions)
  } catch (e) { /* 文档不存在 → 全部订阅 */ }
  if (cache) cache.set(openid, subs)
  return subs
}

// ===== 通知计划（按预约时间轴裁剪：返回完整未来适用集合，不硬截断）=====
// 本函数只回答「这场预约在时间轴上哪些提醒类型仍处于未来、应当被启用」，返回 4 键布尔（恒含全部键）。
//   reserveSuccess 恒 true（免审即时发 / 待审在审核通过时发）
//   dayBefore      仅当 now < 前一天窗口终点（D-1 dayBeforeAt + dayBeforeWindow）
//   reminder       仅当 now < 开场前触发时刻（否则下单后会被定时任务立即补发，与「预约确认」重复）
//   reminderEnd    仅当 now < 结束触发时刻
// 注意：本计划是「完整未来适用集合」，**不做 ≤3 硬截断**——
//   ① 远期预约的「结束提醒」仍记为 true，remindReservation 会先尝试微信（未授权 → 43101）再走短信兜底，
//      从而保证「短信确保触达」；② 所谓「≤3 条」只约束【提交瞬间的微信授权弹窗】（前端 allocation，见 subscribe.js tmplIdsOfPlan），
//      不约束整条生命周期的发送条数（时间轴类提醒本来就分布在不同的未来节点，互不重叠）。
// 「预约取消」是事件型、不在本计划内：它随取消事件触发，由 cancelReservation 发送并走短信兜底。
// ⚠️ 前端 miniprogram/utils/subscribe.js 的 notifyPlanOf 是本规则的前端镜像（同样返回完整计划，不截断）；
//    提交授权的 ≤3 分配在 tmplIdsOfPlan 实现，两边必须同步修改。

// 'YYYY-MM-DD' ± n 天（非法输入返回 ''）
function shiftDate(dateStr, n) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number)
  if (!y || !m || !d) return ''
  const t = new Date(Date.UTC(y, m - 1, d + (n || 0)))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

// 通知时间窗配置（自 config.smsnotify 归一化，缺省用默认值）
function notifyWindowCfg(smsSw) {
  const s = smsSw || {}
  return {
    dayBeforeAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.dayBeforeAt || '')) ? s.dayBeforeAt : '17:30',
    dayBeforeWindow: typeof s.dayBeforeWindow === 'number' && s.dayBeforeWindow >= 0 ? s.dayBeforeWindow : 180,
    approachingWhen: s.approachingWhen === 'after' ? 'after' : 'before',
    approachingOffset: typeof s.approachingOffset === 'number' && s.approachingOffset >= 0 ? s.approachingOffset : 60,
    expiredWhen: s.expiredWhen === 'before' ? 'before' : 'after',
    expiredOffset: typeof s.expiredOffset === 'number' && s.expiredOffset >= 0 ? s.expiredOffset : 5
  }
}

// 时间轴通知优先级（仅用于文档化顺序，以及作为前端提交弹窗分配时的参考；本函数不再据此截断）
const NOTIFY_PRIORITY = ['reserveSuccess', 'dayBefore', 'reminder', 'reminderEnd']

// 计算本次预约应启用的时间轴通知：返回 4 键布尔对象（恒含全部键，便于落库与判定）。
//   reserveSuccess 恒 true（免审即时发 / 待审在审核通过时发）
//   dayBefore      仅当 now < 前一天窗口终点（D-1 dayBeforeAt + dayBeforeWindow）
//   reminder       仅当 now < 开场前触发时刻（否则下单后会被定时任务立即补发，与「预约确认」重复）
//   reminderEnd    仅当 now < 结束触发时刻
// 不截断：完整未来适用集合（见上方说明）。提交弹窗的 ≤3 分配由前端 tmplIdsOfPlan 负责。
function notifyPlan(reservation, cfg, nowTs) {
  const now = nowTs || Date.now()
  const f = cfg || notifyWindowCfg({})
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

// 本次预约是否启用了某类时间轴通知。
// notifyPlan 缺失（历史预约数据）时返回 true → 保持旧行为，不误拦已有预约的提醒。
function plannedOf(plan, key) {
  if (!plan || typeof plan !== 'object') return true
  return plan[key] !== false
}

// 读取「短信全局开关」配置（config.smsnotify 文档）。缺省视为全部开启。
async function loadSmsSwitch(db) {
  try {
    const r = await db.collection('config').doc('smsnotify').get()
    return (r && r.data) || {}
  } catch (e) { return {} }
}

// 读取「AI 智能预约总开关」配置（config.ai 文档）。缺省视为开启（enabled !== false 即开）。
// 关闭后首页/详情页浮窗与 AI 入口整块隐藏（详见 ai-reserve-spec.md §15）。
async function loadAiSwitch(db) {
  try {
    const r = await db.collection('config').doc('ai').get()
    return r && r.data ? (r.data.enabled !== false) : true
  } catch (e) { return true }
}

// 【微信优先降级】是否跳过短信（默认开启，符合「微信送达就不发短信」设计）：
//   skipSmsIfWxOk 非显式 false 即视为开启 → 同一事件微信订阅已投递（ok:true = errcode 0）则不再补发短信，避免重复打扰。
//   若需「微信 + 短信双通道都发」，在 config.smsnotify 文档显式置 skipSmsIfWxOk:false 即可回退。
// 注意：ok:false（43101 未授权 / 47003 字段非法 / -501001 凭证异常）一律视为「微信没送到」，短信照发兜底。
function shouldSkipSms(smsSw, wxRes) {
  return !!(smsSw && smsSw.skipSmsIfWxOk !== false && wxRes && wxRes.ok === true && !wxRes.skipped)
}

// 判定一条订阅发送结果是否「确实送达微信侧」（供落库排查用）
function wxDelivered(wxRes) { return !!(wxRes && wxRes.ok === true && !wxRes.skipped) }

// 取所有管理员（role 为 owner 或 manager）的 openid，使 owner + manager 都收管理侧通知
async function listAdminOpenids(db) {
  const res = await db.collection(COL.admins).where({ role: _.in(['owner', 'manager']) }).get().catch(() => ({ data: [] }))
  return (res.data || []).map(a => a.openid).filter(Boolean)
}

// 给所有管理员（owner + manager）推送订阅消息（新预约 / 取消等管理侧通知）
// 占位跳过 + 逐个发送 + 失败不阻断主流程；返回每个管理员的发送结果数组供排查
async function notifyAdmins(db, { templateId, data, page }) {
  if (!templateId || templateId.indexOf('TPL_ID_') === 0) {
    return [{ ok: false, skipped: true, reason: 'template not configured', templateId }]
  }
  const ids = await listAdminOpenids(db)
  if (!ids.length) {
    return [{ ok: false, skipped: true, reason: 'no admin(owner/manager) found' }]
  }
  console.log('[notifyAdmins] sending', templateId, 'to', ids.length, 'admin(s):', ids)
  const results = []
  for (const oid of ids) {
    const r = await sendSubscribe({ openid: oid, templateId, data, page: page || 'pages/admin/hub/hub' })
    r.role = 'admin'
    results.push(r)
  }
  return results
}

// ===== 服务号模板消息（templateMessage）相关 =====

// 读取全局通知开关配置（config 集合的 mp 文档）。缺省视为「全部开启」。
async function readMpSwitch(db) {
  try {
    const r = await db.collection('config').doc('mp').get()
    return (r && r.data) || {}
  } catch (e) { return {} }
}
// 单个服务号模板是否开启：config.mp[key] !== false 视为开（缺省开）
function mpOn(mpCfg, key) { return mpCfg ? (mpCfg[key] !== false) : true }

// 由小程序 openid 取得用户「服务号 openid」（users.mpOpenid）。
// 服务号模板消息的 touser 必须是服务号 openid，否则无法送达。未采集（未关注服务号）返回 ''。
async function getMpOpenid(db, openid) {
  if (!openid) return ''
  try {
    const r = await db.collection(COL.users).doc(openid).get()
    return (r && r.data && r.data.mpOpenid) || ''
  } catch (e) { return '' }
}

// ===== 服务号通知（已整体下线，2026-08-23）=====
// 微信自 2023-10-01 起全面下线公众号「模板消息」接口（45103 失效），其替代「订阅通知」授权链路
// 在「小程序 web-view」场景下无法落地（需服务号 JS-SDK 签名，工程量过大）。经用户确认，服务号通知功能
// 整体移除，仅保留【小程序订阅消息】+【短信】双通道。下方 sendMp / notifyAdminsMp 一律 no-op，
// 不再尝试调用微信，避免无谓的 access_token 获取与 45103 日志噪音。MP_TPL 等常量保留仅作历史参考。

// 发送服务号消息（已禁用）：no-op，仅留日志便于排查。
async function sendMp() {
  console.log('[mp] disabled: 服务号通知功能已移除，跳过发送')
  return
}
// 兼容别名
async function sendMpSubscribe() { return sendMp() }

// 给所有管理员发服务号消息（已禁用）：no-op。
async function notifyAdminsMp() {
  console.log('[mp] disabled: 服务号通知功能已移除，跳过管理员发送')
  return
}

// ===== AI 对话配额（单用户每日轮次上限，后台可配）=====
// 配置项位于 config.ai 文档（管理台「AI 预约」页可改）：
//   dailyTurnLimit    每个用户每天允许的 AI 对话轮次数；默认 30；填 0（或负数）= 不限制
//   oaDailyTurnLimit  公众号渠道单独上限（可选）；未设置时沿用 dailyTurnLimit
//   limitReply        超出上限时的回复话术（可选）
// 计数落在独立集合 aiQuota：_id = `ai_${channel}_${openid}_${ymd}`，每天自动换键，无需清理。
// ⚠️ aiQuota 集合必须事先创建（CloudBase 文档库不会自动建集合，向不存在集合写会直接失败）：
//    用 CloudBase MCP writeNoSqlDatabaseStructure action=createCollection 建 aiQuota。
//    集合缺失时 aiQuotaUsed 恒返回 0（不阻断对话，只是限流失效），并打 warn 便于定位。
const AI_DEFAULT_TURN_LIMIT = 30
const AI_DEFAULT_LIMIT_REPLY = '今天的 AI 对话次数已用完啦～您可以点击公众号菜单进入小程序预约，或明天再来找我哦。'

function normalizeAiLimits(d) {
  const s = d || {}
  const num = (v, def) => (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.floor(v) : def
  const base = num(s.dailyTurnLimit, AI_DEFAULT_TURN_LIMIT)
  const oa = (typeof s.oaDailyTurnLimit === 'number' && isFinite(s.oaDailyTurnLimit) && s.oaDailyTurnLimit >= 0)
    ? Math.floor(s.oaDailyTurnLimit) : base
  return {
    dailyTurnLimit: base,
    oaDailyTurnLimit: oa,
    limitReply: (typeof s.limitReply === 'string' && s.limitReply.trim())
      ? s.limitReply.trim().slice(0, 200) : AI_DEFAULT_LIMIT_REPLY
  }
}

// 读取 AI 配额配置（config.ai）；读取失败回落到默认值，绝不阻断对话
async function loadAiLimits() {
  try {
    const r = await db.collection('config').doc('ai').get()
    return normalizeAiLimits(r && r.data)
  } catch (e) { return normalizeAiLimits({}) }
}

// 取某渠道的每日上限（0 = 不限）
function limitOfChannel(limits, channel) {
  const l = limits || normalizeAiLimits({})
  return channel === 'oa' ? l.oaDailyTurnLimit : l.dailyTurnLimit
}

function quotaId(openid, channel) { return `ai_${channel || 'mp'}_${openid}_${bjYmd()}` }

// 当日已用轮次；集合/文档不存在 → 0
async function aiQuotaUsed(openid, channel) {
  if (!openid) return 0
  try {
    const r = await db.collection('aiQuota').doc(quotaId(openid, channel)).get()
    return Number((r && r.data && r.data.count) || 0)
  } catch (e) { return 0 }
}

// 计数 +1（文档不存在则创建）。失败只 warn：限流是成本保护，不应阻断用户对话。
async function incrAiQuota(openid, channel) {
  if (!openid) return
  const id = quotaId(openid, channel)
  const ch = channel || 'mp'
  try {
    await db.collection('aiQuota').doc(id).update({ data: { count: _.inc(1), updatedAt: Date.now() } })
  } catch (e) {
    try {
      await db.collection('aiQuota').doc(id).set({
        data: { openid, channel: ch, ymd: bjYmd(), count: 1, createdAt: Date.now(), updatedAt: Date.now() }
      })
    } catch (e2) {
      console.warn('[aiQuota] incr failed (ignored):', e2 && (e2.message || e2.errMsg || e2))
    }
  }
}

// 统一的「是否还能对话」判定：返回 { allowed, used, limit }
// limit<=0 视为不限；used >= limit 则拒绝本轮。
async function checkAiQuota(limits, openid, channel) {
  const limit = limitOfChannel(limits, channel)
  if (!limit) return { allowed: true, used: 0, limit: 0 }
  const used = await aiQuotaUsed(openid, channel)
  return { allowed: used < limit, used, limit }
}

// ===== 公众号客服消息（message/custom/send）=====
// ⚠️ 出网依赖：客服消息必须直连 api.weixin.qq.com。若云环境限制了公网出站（曾出现 412），
//    本调用会失败——调用方必须 catch 并给出兜底（例如引导用户点菜单进小程序），不能静默。
//    排查：云开发控制台 → 环境 → 网络配置，放行公网访问 / 把 api.weixin.qq.com 加入白名单。
const https = require('https')

function httpsJson(url, opts) {
  const o = opts || {}
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(new Error('URL 非法: ' + url)) }
    const payload = o.body ? Buffer.from(o.body, 'utf8') : null
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: o.method || 'GET',
      timeout: o.timeout || 8000,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : { 'Content-Type': 'application/json' }
    }, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => { buf += c })
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('响应非 JSON: ' + String(buf).slice(0, 200))) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// 二进制版：微信的「生成小程序码」接口成功时直接回图片字节流，失败才回 JSON，
// 所以必须拿原始 Buffer 而不能走 httpsJson（那个强制 utf8 解析）。
function httpsBuffer(url, opts) {
  const o = opts || {}
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(new Error('URL 非法: ' + url)) }
    const payload = o.body ? Buffer.from(o.body, 'utf8') : null
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: o.method || 'GET',
      timeout: o.timeout || 8000,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : { 'Content-Type': 'application/json' }
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), headers: res.headers || {}, status: res.statusCode }))
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// 公众号基础 access_token（与 mpAuth 的「网页授权 OAuth token」是两套，不可混用）。
// 缓存在 config 集合 mpToken 文档，到期前 5 分钟提前续期，避免频繁拉取触发微信频率限制。
async function getMpAccessToken(force) {
  const now = Date.now()
  if (!force) {
    try {
      const r = await db.collection('config').doc('mpToken').get()
      const d = r && r.data
      if (d && d.token && d.expiresAt && (d.expiresAt - now) > 5 * 60 * 1000) return d.token
    } catch (e) { /* 文档不存在 → 走网络获取 */ }
  }
  const appId = process.env.MP_APP_ID || ''
  const secret = process.env.MP_APP_SECRET || ''
  if (!appId || !secret) throw new Error('未配置 MP_APP_ID / MP_APP_SECRET 环境变量')
  const j = await httpsJson(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`)
  if (!j || !j.access_token) {
    throw new Error('获取 access_token 失败：' + JSON.stringify(j).slice(0, 200))
  }
  try {
    await db.collection('config').doc('mpToken').set({
      data: { token: j.access_token, expiresAt: now + (Number(j.expires_in) || 7200) * 1000, updatedAt: now }
    })
  } catch (e) { console.warn('[mpToken] 缓存写入失败（忽略）：', e && (e.message || e.errMsg || e)) }
  return j.access_token
}

// 发送客服消息。msg 形态：
//   { type:'text', content }
//   { type:'miniprogrampage', title, appid, pagepath, thumbMediaId }
// isAi=true 时附带 aimsgcontext.is_ai_msg=1（微信 2025-11-26 起支持，消息下方展示「内容由第三方AI生成」）
async function sendMpCustom({ openid, msg, isAi }) {
  if (!openid) throw new Error('缺少公众号 openid')
  const m = msg || {}
  const body = { touser: openid, msgtype: m.type }
  if (m.type === 'text') {
    body.text = { content: String(m.content || '').slice(0, 2048) }
  } else if (m.type === 'miniprogrampage') {
    // 四个字段官方均为必填，缺一会报参数错误
    if (!m.title || !m.appid || !m.pagepath || !m.thumbMediaId) {
      throw new Error('miniprogrampage 缺少必填字段（title/appid/pagepath/thumbMediaId）')
    }
    body.miniprogrampage = { title: m.title, appid: m.appid, pagepath: m.pagepath, thumb_media_id: m.thumbMediaId }
  } else {
    throw new Error('不支持的客服消息类型：' + m.type)
  }
  if (isAi) body.aimsgcontext = { is_ai_msg: 1 }

  const post = (token) => httpsJson(
    'https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=' + encodeURIComponent(token),
    { method: 'POST', body: JSON.stringify(body) }
  )
  let token = await getMpAccessToken()
  let j = await post(token)
  // 42001/40001：token 过期或失效 → 强制刷新一次再试
  const code = j && j.errcode
  if (code === 42001 || code === 40001 || code === 40014) {
    token = await getMpAccessToken(true)
    j = await post(token)
  }
  if (j && j.errcode) throw new Error(`客服消息发送失败 ${j.errcode}：${j.errmsg || ''}`)
  return j || {}
}

// ===== 顾客自动标签规则引擎 =====

// scene → 来源标签（仅三类有业务语义；其他返回 '' 不展示）
function srcLabel(scene) {
  const s = Number(scene)
  if (s === 1035) return '公众号菜单'
  if (s === 1005 || s === 1150) return '搜索'
  if (s === 1007 || s === 1008 || s === 1036) return '链接分享'
  return ''
}

function daysAgo(ts) {
  if (!ts) return null
  return Math.floor((Date.now() - ts) / 86400000)
}

// 24 小时分布取峰值小时（仅计数最大且 >0 才有意义）
function peakHour(arr24) {
  if (!arr24 || !arr24.length) return -1
  let hi = 0
  for (let i = 1; i < 24; i++) if (arr24[i] > arr24[hi]) hi = i
  return arr24[hi] > 0 ? hi : -1
}

// 自动标签：根据顾客资料(profile) + 聚合结果(agg) 生成标签数组（云端算、不存储，保证单一真相）
// agg 字段：total / firstAt / lastAt / avgParty / avgLeadDays / perProject[{projectId,name,cnt}] / submitHour[24] / sessionHour[24] / weekendRatio
// 缺字段的标签自动跳过（roster 聚合不携带时段/周末时仍可用）。
function customerTags(profile, agg) {
  const tags = []
  if (!agg) return tags
  const total = agg.total || 0
  if (total >= 5) tags.push('高频常客')
  else if (total >= 2) tags.push('回头客')

  const df = daysAgo(agg.firstAt)
  if (df != null && df <= 30) tags.push('新客')

  const dl = daysAgo(agg.lastAt)
  if (total > 0 && dl != null && dl > 90) tags.push('沉睡客')

  const lead = agg.avgLeadDays
  if (typeof lead === 'number' && !isNaN(lead)) {
    if (lead >= 3) tags.push('计划型')
    else if (lead <= 1) tags.push('临时型')
  }

  const peak = peakHour(agg.submitHour) >= 0 ? peakHour(agg.submitHour) : peakHour(agg.sessionHour)
  if (peak >= 20 && peak <= 22) tags.push('夜场客')
  if (typeof agg.weekendRatio === 'number' && agg.weekendRatio >= 0.6) tags.push('周末客')
  if (typeof agg.avgParty === 'number' && agg.avgParty >= 3) tags.push('大桌客')

  if (agg.perProject && agg.perProject.length) {
    const top = agg.perProject.reduce((a, b) => (b.cnt > a.cnt ? b : a), agg.perProject[0])
    if (top.cnt / total >= 0.6 && top.name) tags.push(top.name + '爱好者')
  }

  const src = srcLabel(profile && profile.firstSource)
  if (src) tags.push(src)
  return tags
}

// ===== 小程序 access_token + URL Link（公众号「一键跳小程序」的唯一免费通路）=====
// ⚠️ 与上面 getMpAccessToken 是两套完全独立的凭证，绝不可混用：
//   · 服务号 token：能发客服消息/取素材，但受「服务号 IP 白名单」约束；云函数出口 IP 每次漂移 ⇒ 恒 40164，死路。
//   · 小程序 token：**不受 IP 白名单约束**（2026-09-23 实测：真实 AppID + 错 secret → 40125「invalid appsecret」，
//     而不是 40164 ⇒ 请求已越过 IP 校验）。因此可以在云函数里直接取，用来生成 URL Link。
//   判据教训：只有 40164 才代表 IP 被拦；40001/40125 都说明通路是好的（详见项目 MEMORY）。
const WXA_APPID_FALLBACK = 'wxb97578ed89c6e2c7'
let _wxaTokMem = { at: 0, v: '' }

async function getWxaAccessToken(force) {
  const now = Date.now()
  if (!force && _wxaTokMem.v && (now - _wxaTokMem.at) < 60000) return _wxaTokMem.v
  if (!force) {
    try {
      const r = await db.collection('config').doc('wxaToken').get()
      const d = r && r.data
      if (d && d.token && d.expiresAt && (d.expiresAt - now) > 5 * 60 * 1000) {
        _wxaTokMem = { at: now, v: d.token }
        return d.token
      }
    } catch (e) { /* 文档不存在 → 走网络获取 */ }
  }
  const appId = process.env.WXA_APP_ID || WXA_APPID_FALLBACK
  let secret = process.env.WXA_APP_SECRET || ''
  if (!secret) {
    try {
      const r = await db.collection('config').doc('wxa').get()
      secret = (r && r.data && r.data.appSecret) || ''
    } catch (e) { /* ignore */ }
  }
  // 兜底兼容「历史落点」：config/wxAppSecret.value
  // 2026-08-17 做 getPhoneNumber 时由一次性临时函数 tmpSetSecret 写入（当时 getPhoneNumber 需要 secret）；
  // 后改走云调用，该文档沉睡至今。留着这条兜底，免得「密钥明明在库里却读不到」。
  // 注：若读到的是已重置的旧值，微信会回 40125（invalid appsecret），报错信息里可识别。
  if (!secret) {
    try {
      const r2 = await db.collection('config').doc('wxAppSecret').get()
      secret = (r2 && r2.data && (r2.data.value || r2.data.appSecret)) || ''
    } catch (e) { /* ignore */ }
  }
  if (!secret) throw new Error('未配置小程序 AppSecret（环境变量 WXA_APP_SECRET，或 config 文档 wxa.appSecret / wxAppSecret.value）')
  const j = await httpsJson(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`)
  if (!j || !j.access_token) throw new Error('小程序 access_token 获取失败：' + JSON.stringify(j).slice(0, 200))
  try {
    await db.collection('config').doc('wxaToken').set({
      data: { token: j.access_token, expiresAt: now + (Number(j.expires_in) || 7200) * 1000, updatedAt: now }
    })
  } catch (e) { console.warn('[wxaToken] 缓存写入失败（忽略）：', e && (e.message || e.errMsg || e)) }
  _wxaTokMem = { at: now, v: j.access_token }
  return j.access_token
}

// 生成「微信内直达小程序」的 URL Link（形如 https://wxaurl.cn/xxxx）。
// 用户在微信里点一下即唤起小程序；path/query 可带参 ⇒ 能把确认信息与 log（漏斗回写）一起带过去。
// 注意：小程序须为「非个人主体」且已发布；每日生成上限 100 万次。
// 小程序版本环境（release=线上正式版 / trial=体验版 / develop=开发版）。
// 为什么需要可配：URL Link 与小程序码都会把用户送到**指定版本**。
//   若线上正式版还没有本次新加的能力（例如「点卡片直达小程序确认页」），生成的链接就会落到旧版页面，
//   表现像"功能没生效"（真机复现）。此时把 WXA_ENV_VERSION 设为 trial，配合「体验版」即可先行验证，
//   等正式版审核通过再切回 release。默认 release —— 对真实顾客这是唯一正确值。
function wxaEnvVersion() {
  const v = String(process.env.WXA_ENV_VERSION || 'release').toLowerCase()
  return (v === 'trial' || v === 'develop') ? v : 'release'
}

async function generateUrlLink({ path, query, envVersion }) {
  if (!path) throw new Error('generateUrlLink 缺少 path')
  // ⚠️ 实测（2026-09-23）：只有 is_expire:false（永久链接）稳过。
  //   · is_expire:true + expire_type:1 + expire_time  → 85401「time limit between 1min and 30days」
  //     （即便 expire_time 落在 1min~30days 区间内也照样报，微信对时间戳模式校验异常）
  //   · is_expire:true + expire_type:0 + expire_interval:29 → 可用，但链接 29 天后失效
  // ⇒ 固定用永久链接，卡片文案里的链接永远不会过期。返回域名可能是 wxaurl.cn 或 wxmpurl.cn（都合法）。
  const body = {
    path: String(path),
    query: query ? String(query) : '',
    env_version: envVersion || wxaEnvVersion(),
    is_expire: false
  }
  const call = (token) => httpsJson(
    'https://api.weixin.qq.com/wxa/generate_urllink?access_token=' + encodeURIComponent(token),
    { method: 'POST', body: JSON.stringify(body) }
  )
  let token = await getWxaAccessToken()
  let j = await call(token)
  const code = j && j.errcode
  // 42001/40001/40014：token 过期或失效 → 强制刷新一次再试
  if (code === 42001 || code === 40001 || code === 40014) {
    token = await getWxaAccessToken(true)
    j = await call(token)
  }
  if (j && j.errcode) throw new Error(`generate_urllink 失败 ${j.errcode}：${j.errmsg || ''}`)
  const link = (j && (j.url_link || j.urlLink)) || ''
  if (!link) throw new Error('generate_urllink 未返回 url_link')
  return link
}

// 带容器内缓存的 URL Link：同一 path+query 在容器寿命内只生成一次（省一次公网往返，被动回复 5s 预算很紧）。
const _linkMem = new Map()
async function generateUrlLinkCached(path, query, envVersion) {
  const ev = envVersion || wxaEnvVersion()
  const key = ev + '|' + path + '?' + (query || '')
  const hit = _linkMem.get(key)
  if (hit && hit.exp > Date.now()) return hit.link
  const link = await generateUrlLink({ path, query, envVersion: ev })
  if (_linkMem.size > 200) _linkMem.clear()
  // 链接是永久的，缓存只是为了省一次公网往返（被动回复 5s 预算很紧）。
  _linkMem.set(key, { link, exp: Date.now() + 6 * 60 * 60 * 1000 })
  return link
}

// 生成「小程序码」图片（返回 PNG Buffer）。
// 为什么需要它：公众号被动回复发不了 image 消息（要素材 MediaId，而素材接口需要服务号 token，
// 被 IP 白名单拦死）；但图文消息(news)的 PicUrl 接受**任意公网图片链接**。
// ⇒ 把小程序码上传到云存储/静态托管后填进 PicUrl，就是免费方案下「带二维码的卡片」。
// scene：扫码进入后小程序 onLoad 的 options.scene（≤32 字符）；page 必须是小程序**已发布**的页面。
async function getWxaQrCode(page, scene, width) {
  const body = {
    scene: String(scene == null || scene === '' ? 'oa' : scene).slice(0, 32),
    page: String(page || 'pages/ai/ai'),
    check_path: false,          // false 才允许 env_version 生效（true 会校验页面是否已发布）
    env_version: wxaEnvVersion(),
    width: Math.max(280, Math.min(1280, Number(width) || 430)),
    auto_color: false,
    is_hyaline: false
  }
  const call = (token) => httpsBuffer(
    'https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=' + encodeURIComponent(token),
    { method: 'POST', body: JSON.stringify(body) }
  )
  const parseErr = (r) => {
    let j = {}
    try { j = JSON.parse(r.buf.toString('utf8')) } catch (e) { return '未知响应：' + r.buf.toString('utf8').slice(0, 200) }
    return `getwxacodeunlimit 失败 ${j.errcode}：${j.errmsg || ''}`
  }

  let token = await getWxaAccessToken()
  let r = await call(token)
  if (isJsonResp(r)) {
    let j = {}
    try { j = JSON.parse(r.buf.toString('utf8')) } catch (e) { throw new Error(parseErr(r)) }
    // token 过期 → 强刷一次再试
    if (j.errcode === 42001 || j.errcode === 40001 || j.errcode === 40014) {
      token = await getWxaAccessToken(true)
      r = await call(token)
      if (!isJsonResp(r)) return r.buf
    }
    throw new Error(parseErr(r))
  }
  return r.buf
}

// 微信接口失败时回 JSON（以 { 开头），成功时回二进制图片 → 靠首字节判别最可靠
function isJsonResp(r) {
  const ct = String((r.headers && r.headers['content-type']) || '')
  if (ct.indexOf('json') >= 0) return true
  return !!(r.buf && r.buf.length && r.buf[0] === 0x7b)
}

module.exports = {
  cloud, db, _, $, COL, TPL, MP_TPL, DEFAULT_STORE_NAME,
  ok, fail, wxCtx, getRole, ensureOwner, ymd, addDays, bjYmd, bjAddDays, bjTs, effStatus, monthDay, monthDaySlash, getStoreName,
  sendSubscribe, listAdminOpenids, notifyAdmins,
  readMpSwitch, mpOn, getMpOpenid, sendMp, sendMpSubscribe, notifyAdminsMp,
  srcLabel, customerTags, loadSubscribeSwitch, subOn,
  loadSmsSwitch, shouldSkipSms, wxDelivered, loadAiSwitch,
  SUB_KEYS, normalizeSubs, subbedOf, loadUserSubs,
  shiftDate, notifyWindowCfg, notifyPlan, plannedOf, NOTIFY_PRIORITY,
  // AI 配额（每日轮次上限，后台可配）
  AI_DEFAULT_TURN_LIMIT, AI_DEFAULT_LIMIT_REPLY, normalizeAiLimits, loadAiLimits,
  limitOfChannel, aiQuotaUsed, incrAiQuota, checkAiQuota,
  // 公众号客服消息
  httpsJson, getMpAccessToken, sendMpCustom,
  // 小程序 access_token / URL Link / 小程序码（公众号跳小程序的免费通路）
  getWxaAccessToken, generateUrlLink, generateUrlLinkCached, getWxaQrCode, wxaEnvVersion
}
