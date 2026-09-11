// utils/util.js — 通用工具
// YYYY-MM-DD
function ymd(d) {
  const t = d || new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// "HH:MM" -> 当天分钟数
function parseHm(t) {
  const a = String(t || '').split(':').map(Number)
  return (isNaN(a[0]) ? 0 : a[0]) * 60 + (isNaN(a[1]) ? 0 : a[1])
}

// 场次是否已过预约截止（已过期，不可再约）
// cutoff: { mode:'before'|'after', minutes }；未配置 / 非法 则不限制（返回 false）
//   mode 'before'：场次开始前 minutes 分钟截止（默认语义）
//   mode 'after' ：场次开始后 minutes 分钟截止
// 截止时刻 = 场次开始时刻 ± minutes；now >= 截止时刻 即视为已过期
function isSessionExpired(dateStr, startStr, cutoff) {
  if (!cutoff || (cutoff.mode !== 'before' && cutoff.mode !== 'after') || !(Number(cutoff.minutes) > 0)) return false
  const [y, mo, d] = String(dateStr || '').split('-').map(Number)
  if (!y || !mo || !d) return false
  const mins = parseHm(startStr)
  const start = new Date(y, mo - 1, d, Math.floor(mins / 60), mins % 60)
  const offset = Number(cutoff.minutes) * 60000
  const deadline = cutoff.mode === 'before'
    ? new Date(start.getTime() - offset)
    : new Date(start.getTime() + offset)
  return Date.now() >= deadline.getTime()
}

// 友好日期标签：2026-08-14 周四
function dateLabel(y) {
  const [y0, m, d] = y.split('-').map(Number)
  const dt = new Date(y0, m - 1, d)
  return `${y} ${WEEK[dt.getDay()]}`
}

// 日历/卡片日期标签：YYYY-MM-DD -> MM/DD（如 09/07）
function monthDaySlash(ymdStr) {
  const [y0, m, d] = String(ymdStr || '').split('-').map(Number)
  if (!m || !d) return ymdStr || ''
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`
}

// 校验手机号（中国大陆 11 位）
function isPhone(v) {
  return /^1[3-9]\d{9}$/.test(v)
}

// 请求微信订阅消息授权（过滤未配置的占位模板 ID，避免传入 TPL_ID_* 报错）
// 需在用户手势（点击）回调内调用，否则弹窗可能被拦截
// ⚠️ 微信限制：一次调用最多 3 个 tmplIds，超过整体失败(errCode 20003)且不弹窗；
// 故按 3 个一组拆分逐组请求，确保 4 个模板（成功/取消/开场提醒/结束提醒）都能授权
function requestSubscribe(tmplIds) {
  const valid = (tmplIds || []).filter(id => id && !String(id).startsWith('TPL_ID_'))
  if (!valid.length) return
  if (typeof wx === 'undefined' || !wx.requestSubscribeMessage) return
  for (let i = 0; i < valid.length; i += 3) {
    wx.requestSubscribeMessage({
      tmplIds: valid.slice(i, i + 3),
      success(res) { console.log('[subscribe] 授权结果:', JSON.stringify(res)) },
      fail(err) { console.warn('[subscribe] 授权失败:', JSON.stringify(err)) }
    })
  }
}

module.exports = { ymd, dateLabel, monthDaySlash, isPhone, WEEK, requestSubscribe, parseHm, isSessionExpired }
