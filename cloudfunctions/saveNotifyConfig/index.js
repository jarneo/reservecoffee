// saveNotifyConfig — 保存全局通知配置（owner）
// 仅覆盖传入字段；subscribe：8 个订阅模板开关 + texts（可编辑固定语）
// mp：appId / token（公众平台消息推送 Token）/ 4 个服务号模板开关（已废弃保留）
// sms：5 个短信开关 success/approaching/expired/cancel/dayBefore + 发送时间配置
//   successDelay     预定成功后延迟分钟（0 / 10，默认 0）
//   approachingWhen  临近短信：开始前/后（'before' | 'after'，默认 'before'）
//   approachingOffset 临近偏移分钟（默认 60）
//   expiredWhen      过期短信：结束前/后（'before' | 'after'，默认 'after'）
//   expiredOffset    过期偏移分钟（默认 5）
//   dayBeforeAt      提前一天通知的发送时刻 'HH:mm'（默认 '17:30'，按北京时间判定）
//   cancelDelay      取消短信延迟分钟（默认 3；与 15 分钟定时精度配合，发前复校预约仍为已取消）
//   skipSmsIfWxOk    微信优先降级开关：true=微信订阅消息已送达则不发对应短信；false=双通道都发
const { db, ok, fail, wxCtx, getRole } = require('./lib')

const SUB_KEYS = ['reserveSuccess', 'reserveCancel', 'reminder', 'reminderEnd', 'dayBefore', 'adminNew', 'adminCancel', 'adminReview']
const MP_KEYS = ['adminNew', 'reserveSuccess', 'reserveCancel', 'adminReview']
const SMS_KEYS = ['success', 'approaching', 'expired', 'cancel', 'dayBefore']
const SMS_TIMING = ['successDelay', 'approachingWhen', 'approachingOffset', 'expiredWhen', 'expiredOffset', 'dayBeforeAt', 'cancelDelay', 'skipSmsIfWxOk']

// 保存 config 集合里的指定文档：存在则 update（只覆盖传入字段），不存在则 set 新建。
// ⚠️ 文档 id 由 doc(id) 决定，**set({data}) 的 data 里绝不能带 _id**，否则 SDK 抛
//    `document.set:fail -501007 invalid parameters. 不能更新_id的值`，函数整体失败，
//    客户端只看到笼统的 -504002（云函数执行失败）。update 同理。
async function upsertConfig(id, patch) {
  const col = db.collection('config')
  const ex = await col.doc(id).get().catch(() => ({ data: null }))
  if (ex.data) await col.doc(id).update({ data: patch })
  else await col.doc(id).set({ data: patch })
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可配置')

  const wrote = []

  // ===== 订阅消息开关 =====
  if (event.subscribe && typeof event.subscribe === 'object') {
    const s = event.subscribe
    const patch = {}
    SUB_KEYS.forEach(k => { if (typeof s[k] === 'boolean') patch[k] = s[k] })
    if (s.texts && typeof s.texts === 'object') patch.texts = s.texts
    await upsertConfig('subscribe', patch)
    wrote.push('subscribe')
  }

  // ===== 服务号配置（仅 4 个模板开关；AppID / Token 已由云环境托管，不再在此配置） =====
  if (event.mp && typeof event.mp === 'object') {
    const m = event.mp
    const patch = {}
    MP_KEYS.forEach(k => { if (typeof m[k] === 'boolean') patch[k] = m[k] })
    await upsertConfig('mp', patch)
    wrote.push('mp')
  }

  // ===== 短信开关 + 发送时间配置（全局） =====
  if (event.sms && typeof event.sms === 'object') {
    const s = event.sms
    const patch = {}
    SMS_KEYS.forEach(k => { if (typeof s[k] === 'boolean') patch[k] = s[k] })
    if (typeof s.successDelay === 'number') patch.successDelay = Math.max(0, Math.min(1440, s.successDelay))
    if (s.approachingWhen === 'before' || s.approachingWhen === 'after') patch.approachingWhen = s.approachingWhen
    if (typeof s.approachingOffset === 'number') patch.approachingOffset = Math.max(0, Math.min(1440, s.approachingOffset))
    if (s.expiredWhen === 'before' || s.expiredWhen === 'after') patch.expiredWhen = s.expiredWhen
    if (typeof s.expiredOffset === 'number') patch.expiredOffset = Math.max(0, Math.min(1440, s.expiredOffset))
    // 提前一天通知的发送时刻（'HH:mm'，北京时间）；非法值丢弃，读取端默认 17:30
    if (typeof s.dayBeforeAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.dayBeforeAt)) patch.dayBeforeAt = s.dayBeforeAt
    // 前一天提醒的发送时间窗（分钟，默认 180）：超出 [dayBeforeAt, +window] 不再补发，避免深夜打扰
    if (typeof s.dayBeforeWindow === 'number') patch.dayBeforeWindow = Math.max(0, Math.min(1440, s.dayBeforeWindow))
    // 取消短信延迟分钟（0~60，默认 3）
    if (typeof s.cancelDelay === 'number') patch.cancelDelay = Math.max(0, Math.min(60, s.cancelDelay))
    // 微信优先降级开关
    if (typeof s.skipSmsIfWxOk === 'boolean') patch.skipSmsIfWxOk = s.skipSmsIfWxOk
    await upsertConfig('smsnotify', patch)
    wrote.push('smsnotify')
  }

  return ok({ saved: true, wrote })
}
