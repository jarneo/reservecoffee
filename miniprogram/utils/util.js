// utils/util.js — 通用工具
// YYYY-MM-DD
function ymd(d) {
  const t = d || new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 友好日期标签：2026-08-14 周四
function dateLabel(y) {
  const [y0, m, d] = y.split('-').map(Number)
  const dt = new Date(y0, m - 1, d)
  return `${y} ${WEEK[dt.getDay()]}`
}

// 校验手机号（中国大陆 11 位）
function isPhone(v) {
  return /^1[3-9]\d{9}$/.test(v)
}

module.exports = { ymd, dateLabel, isPhone, WEEK }
