// cloudfunctions/_lib/index.js — 共享库（部署时由脚本复制到每个云函数目录为 lib.js）
// 提供：云初始化、数据库引用、响应包装、角色判定、日期工具、订阅消息占位。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

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
  reminderEnd: 'ShNSAxZvFsDgyZhFfi3OTUoYqm5khLVJkhCnqI1IEeo'       // 结束提醒（顾客，仅预订人）
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

// 当前日期 YYYY-MM-DD（Asia/Shanghai）
function ymd(d) {
  const t = d || new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

// 今天 + n 天
function addDays(n) {
  const t = new Date()
  t.setDate(t.getDate() + n)
  return ymd(t)
}

// 友好短日期：YYYY-MM-DD -> M月D日（如 8月20日），用于订阅/短信文案
function monthDay(ymdStr) {
  const [y, m, d] = String(ymdStr || '').split('-').map(Number)
  if (!m || !d) return ymdStr || ''
  return `${m}月${d}日`
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
async function sendSubscribe({ openid, templateId, data, page }) {
  if (!openid || !templateId || templateId.indexOf('TPL_ID_') === 0) {
    return { ok: false, skipped: true, reason: 'template not configured', openid, templateId }
  }
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      data,
      page: page || 'pages/index/index'
    })
    return { ok: true, openid, templateId }
  } catch (e) {
    // 关键错误码：43101=用户未授权订阅模板；47003=字段值/关键字非法；47004=模板不存在
    const errCode = e && (e.errCode !== undefined ? e.errCode : e.code)
    const errMsg = (e && e.message) ? e.message : String(e)
    console.warn('[subscribe] send failed:', errCode, errMsg, 'tmpl=', templateId)
    return { ok: false, openid, templateId, errCode, errMsg }
  }
}

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

module.exports = {
  cloud, db, _, $, COL, TPL, MP_TPL, DEFAULT_STORE_NAME,
  ok, fail, wxCtx, getRole, ensureOwner, ymd, addDays, monthDay, getStoreName,
  sendSubscribe, listAdminOpenids, notifyAdmins,
  readMpSwitch, mpOn, getMpOpenid, sendMp, sendMpSubscribe, notifyAdminsMp,
  srcLabel, customerTags
}
