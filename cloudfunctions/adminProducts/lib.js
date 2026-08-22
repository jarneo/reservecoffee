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

// 服务号模板消息（templateMessage）模板 ID（微信公众平台申请）。
// 与订阅消息不同：服务号消息需用户「关注服务号」后按「服务号 openid」送达（见 getMpOpenid）。
// 字段键与用户在公众平台申请的模板结构一致；data 构造在各触发函数里完成。
const MP_TPL = {
  adminNew: 'JQI4jXsKyQAa2zU_kbKuhrXPV4kQHW_n_6hPVUhoLIQ',      // 餐位被预订提醒（管理员 owner+manager）· 免审下单成功
  reserveSuccess: '63vHJHcLMU2tW27b2MdwAmxp7LMwTWe6oRB4O_PcXYs', // 订座结果提醒·成功（顾客）· 免审成功 / 审核通过
  reserveCancel: '63vHJHcLMU2tW27b2MdwAmxp7LMwTWe6oRB4O_PcXYs',  // 订座结果提醒·取消（顾客+管理员）· 与上同一模板，用 const1 区分「已预约/已取消」
  adminReview: 'eBa1lSsI5HY37Funet_Hiz4QuY2W6kQanSDV94aPgxA'     // 收到新订餐订单通知（管理员 owner+manager）· 待审下单成功
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

// 发送订阅消息（占位实现：捕获失败不抛出）
async function sendSubscribe({ openid, templateId, data, page }) {
  if (!openid || !templateId || templateId.indexOf('TPL_ID_') === 0) {
    console.log('[subscribe] skip (template not configured):', templateId)
    return
  }
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      data,
      page: page || 'pages/index/index'
    })
  } catch (e) {
    console.warn('[subscribe] send failed (ignored):', e.message)
  }
}

// 取所有管理员（role 为 owner 或 manager）的 openid，使 owner + manager 都收管理侧通知
async function listAdminOpenids(db) {
  const res = await db.collection(COL.admins).where({ role: _.in(['owner', 'manager']) }).get().catch(() => ({ data: [] }))
  return (res.data || []).map(a => a.openid).filter(Boolean)
}

// 给所有管理员（owner + manager）推送订阅消息（新预约 / 取消等管理侧通知）
// 占位跳过 + 逐个发送 + 失败不阻断主流程
async function notifyAdmins(db, { templateId, data, page }) {
  if (!templateId || templateId.indexOf('TPL_ID_') === 0) {
    console.log('[notifyAdmins] skip (template not configured):', templateId)
    return
  }
  const ids = await listAdminOpenids(db)
  if (!ids.length) {
    console.log('[notifyAdmins] no admin(owner/manager) found')
    return
  }
  for (const oid of ids) {
    await sendSubscribe({ openid: oid, templateId, data, page: page || 'pages/admin/hub/hub' })
  }
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

// 发送服务号模板消息（templateMessage）。找不到 mpOpenid 或模板未配置时优雅跳过（不阻断主流程）。
async function sendMp({ mpOpenid, templateId, data, url, miniprogram }) {
  if (!mpOpenid || !templateId || templateId.indexOf('TPL_ID_') === 0) {
    console.log('[mp] skip (no mpOpenid or template):', templateId)
    return
  }
  try {
    await cloud.openapi.templateMessage.send({
      touser: mpOpenid,
      templateId,
      data,
      url: url || '',
      miniprogram: miniprogram || undefined
    })
  } catch (e) {
    console.warn('[mp] send failed (ignored):', e.message)
  }
}

// 给所有管理员（owner + manager）发服务号模板消息（需其已关注服务号并采集到 mpOpenid）。
async function notifyAdminsMp(db, { templateId, data }) {
  if (!templateId || templateId.indexOf('TPL_ID_') === 0) return
  const ids = await listAdminOpenids(db)
  for (const oid of ids) {
    const mp = await getMpOpenid(db, oid)
    if (mp) await sendMp({ mpOpenid: mp, templateId, data })
  }
}

module.exports = {
  cloud, db, _, $, COL, TPL, MP_TPL, DEFAULT_STORE_NAME,
  ok, fail, wxCtx, getRole, ensureOwner, ymd, addDays, monthDay, getStoreName,
  sendSubscribe, listAdminOpenids, notifyAdmins,
  readMpSwitch, mpOn, getMpOpenid, sendMp, notifyAdminsMp
}
