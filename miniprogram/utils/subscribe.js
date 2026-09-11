// 订阅消息模板 ID 集中管理（与 cloudfunctions/_lib/index.js 的 TPL 一一对应）
// 后端用它发、前端用它请求用户授权，两者必须保持一致。改动时只改这里一处。
const TPLS = {
  reserveSuccess: 'ShNSAxZvFsDgyZhFfi3OTbofXCzjsM5P1-sSD8ZU2e4', // 预约成功（顾客）
  reserveCancel: 'Y1VIDe6Y_DiQqzE_FaaBzvNyD2nErGogF5pCbLed_u8', // 预约取消（顾客）
  reminder: 'OTbjHkCiDnS2a5r0-6AIf2ze41-M2flVKAKbt6LWe6c',     // 开场前提醒（顾客）
  adminNew: 'AJ8iCZgYFaNoSmwmrwwivnRTnJ3BvFu5sOeg4Wa-3aM',      // 新预约提醒（管理员）
  adminCancel: 'TpTXSsqC4i8F_GtN_boeKh4TXjVI-1rXUwA01AIdO5Q',   // 预约取消提醒（管理员）
  adminReview: 'UQJ5AfBWVUTQO-upC-3_W-UeDu_BgPPGoyj11Ei5Py8',   // 待审核提醒（管理员）
  reminderEnd: 'ShNSAxZvFsDgyZhFfi3OTUoYqm5khLVJkhCnqI1IEeo',  // 结束提醒（顾客，仅预订人）
  dayBefore: 'rQEgm5zUep1S9oGeYKYUEawhPK3rs48EQwNncx0HP04'     // 前一天提醒（顾客，每天 17:30 推送次日预约）
}

// 顾客侧需要授权的订阅模板（成功 / 取消 / 开场提醒 / 结束提醒 / 前一天提醒）
// ⚠️ 微信一次最多 3 个 tmplIds，util.requestSubscribe 会自动按 3 个一组分片
const BOOKER_TPLS = [TPLS.reserveSuccess, TPLS.reserveCancel, TPLS.reminder, TPLS.reminderEnd, TPLS.dayBefore]
// 管理员侧需要授权的订阅模板（新预约 / 取消 / 待审核）
const ADMIN_TPLS = [TPLS.adminNew, TPLS.adminCancel, TPLS.adminReview]

module.exports = { TPLS, BOOKER_TPLS, ADMIN_TPLS }
