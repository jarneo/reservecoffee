// saveNotifyConfig — 保存全局通知配置（owner）
// 仅覆盖传入字段；subscribe：7 个订阅模板开关 + texts（可编辑固定语）
// mp：appId / token（公众平台消息推送 Token）/ 4 个服务号模板开关
const { db, ok, fail, wxCtx, getRole } = require('./lib')

const SUB_KEYS = ['reserveSuccess', 'reserveCancel', 'reminder', 'reminderEnd', 'adminNew', 'adminCancel', 'adminReview']
const MP_KEYS = ['adminNew', 'reserveSuccess', 'reserveCancel', 'adminReview']

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可配置')

  // ===== 订阅消息开关 =====
  if (event.subscribe && typeof event.subscribe === 'object') {
    const s = event.subscribe
    const patch = {}
    SUB_KEYS.forEach(k => { if (typeof s[k] === 'boolean') patch[k] = s[k] })
    if (s.texts && typeof s.texts === 'object') patch.texts = s.texts
    const ex = await db.collection('config').doc('subscribe').get().catch(() => ({ data: null }))
    if (ex.data) await db.collection('config').doc('subscribe').update({ data: patch })
    else await db.collection('config').doc('subscribe').set({ data: Object.assign({ _id: 'subscribe' }, patch) })
  }

  // ===== 服务号配置（仅 4 个模板开关；AppID / Token 已由云环境托管，不再在此配置） =====
  if (event.mp && typeof event.mp === 'object') {
    const m = event.mp
    const patch = {}
    MP_KEYS.forEach(k => { if (typeof m[k] === 'boolean') patch[k] = m[k] })
    const ex = await db.collection('config').doc('mp').get().catch(() => ({ data: null }))
    if (ex.data) await db.collection('config').doc('mp').update({ data: patch })
    else await db.collection('config').doc('mp').set({ data: Object.assign({ _id: 'mp' }, patch) })
  }

  return ok({ saved: true })
}
