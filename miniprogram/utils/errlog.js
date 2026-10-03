// miniprogram/utils/errlog.js — 前端全局错误上报
//
// 接入点：app.js 的 onError（JS 异常）与 wx.onUnhandledRejection（Promise 未捕获拒绝）。
// 为什么需要：项目此前无任何全局错误日志，线上报错（如「分享到朋友圈打开失败」）
//   只能靠用户口述，无法定位是页面、数据还是环境问题。
//
// 三条铁律（都来自踩坑经验）：
//   ① 绝不 throw —— 上报失败绝不能变成新的报错源；
//   ② 绝不 await —— onError 里不能阻塞，fire-and-forget；
//   ③ 不落敏感信息 —— 不记 openid 原文、不记 query 值（可能含手机号）。

const { call } = require('./cloud')

// 同一次启动内，对同一错误只上报一次（避免死循环报错把日志刷爆）
const sent = {}
const MAX_PER_SESSION = 20
let count = 0

// 当前页面路由（onError 时页面可能已卸载，取最后一个即可）
function currentRoute() {
  try {
    const pages = getCurrentPages()
    if (!pages || !pages.length) return ''
    const p = pages[pages.length - 1]
    return (p && (p.route || p.__route__)) || ''
  } catch (e) { return '' }
}

// 设备与运行环境摘要：排查「某机型必现」类问题必需
function uaInfo() {
  try {
    const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
    return [info.model, info.system, info.version, info.SDKVersion].filter(Boolean).join(' / ')
  } catch (e) { return '' }
}

function envVersion() {
  try {
    return ((typeof __wxConfig !== 'undefined' && __wxConfig.envVersion) || '') + ''
  } catch (e) { return '' }
}

function report(type, err) {
  try {
    if (count >= MAX_PER_SESSION) return
    const msg = (err && (err.message || err.errMsg)) || String(err || 'unknown')
    const key = type + '|' + msg
    if (sent[key]) return
    sent[key] = 1
    count++

    // 入口信息：scene 能区分「从哪来」（含 1154 朋友圈单页模式）
    let scene = 0
    try {
      const opt = (wx.getEnterOptionsSync && wx.getEnterOptionsSync()) || {}
      scene = Number(opt.scene) || 0
    } catch (e) { /* ignore */ }

    call('logError', {
      type,
      errMsg: msg,
      stack: (err && err.stack) || '',
      route: currentRoute(),
      scene,
      ua: uaInfo(),
      envVersion: envVersion()
    }).catch(() => {})   // 铁律①：不 await、②：不 throw
  } catch (e) { /* 铁律① */ }
}

function install() {
  const app = getApp()
  if (app && typeof app.onError === 'function') {
    app.onError(err => report('onError', err))
  }
  try {
    if (typeof wx.onUnhandledRejection === 'function') {
      wx.onUnhandledRejection(res => report('unhandledRejection', (res && res.reason) || null))
    }
  } catch (e) { /* 老基础库无此 API */ }
}

module.exports = { install, report }
