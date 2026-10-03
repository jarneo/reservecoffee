// notifyLog.js — 通知发送流水（订阅消息 / 短信）
//
// 为什么必须单独打点：reservations 上只有 smsSuccessAt / reminded 这类「标记位」，
//   ① 不记录失败（模板未授权 43101、平台拒收等非异常失败都留不下痕迹）；
//   ② 不记录条数（管理员与顾客各一条时只会知道"发过"）；
//   ③ 无法按时间范围聚合（没有独立的时间字段）。
// 数据分析要统计「订阅通知 / 短信通知」的真实发送量，只能靠这张流水表。
//
// ⚠️ CloudBase **不会自动建集合**：notifyLogs 必须先由 MCP createCollection 创建，
//    并给 ts（数字时间戳，供范围查询）建索引，否则 add() 会静默失败。
// ⚠️ 打点失败绝不能影响主流程 —— 通知已经发出去了，流水没记上只是统计少一条（warn 兜底）。
const NOTIFY_LOG_COL = 'notifyLogs'

/**
 * 写一条通知流水
 * @param {object} db CloudBase 数据库实例
 * @param {object} o
 *   channel: 'wx'（订阅消息）/ 'sms'（短信）
 *   scene:   场景键 reserveSuccess / dayBefore / reminder / reminderEnd / reserveCancel / adminNew / adminCancel ...
 *   audience:'customer' / 'admin'
 *   templateId / openid / phone / reservationId / ok / errCode / errMsg
 */
async function logNotify(db, o) {
  const p = o || {}
  try {
    await db.collection(NOTIFY_LOG_COL).add({
      data: {
        channel: p.channel || '',
        scene: p.scene || '',
        audience: p.audience || '',
        templateId: String(p.templateId || ''),
        openid: p.openid || '',
        phone: p.phone || '',
        reservationId: p.reservationId || '',
        ok: !!p.ok,
        errCode: (p.errCode == null) ? null : p.errCode,
        errMsg: p.errMsg ? String(p.errMsg).slice(0, 200) : '',
        ts: p.ts || Date.now(),             // 数字 ms：范围查询 + 索引都用它
        createdAt: db.serverDate()
      }
    })
  } catch (e) {
    console.warn('[notifyLog] write failed (ignored):', e && (e.message || e.errMsg || e))
  }
}

module.exports = { logNotify, NOTIFY_LOG_COL }
