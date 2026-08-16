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
  stats: 'stats_daily',
  products: 'products',
  reviews: 'reviews'
}

// 订阅消息模板占位（申请到后替换字符串即可；未申请时发送失败不阻断主流程）
const TPL = {
  reserveSuccess: 'TPL_ID_RESERVE_SUCCESS',   // 预约成功
  reserveReview: 'TPL_ID_RESERVE_REVIEW',     // 待审核
  reserveCancel: 'TPL_ID_RESERVE_CANCEL',     // 预约取消
  reviewResult: 'TPL_ID_REVIEW_RESULT'        // 审核结果
}

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

module.exports = {
  cloud, db, _, $, COL, TPL,
  ok, fail, wxCtx, getRole, ensureOwner, ymd, addDays, sendSubscribe
}
