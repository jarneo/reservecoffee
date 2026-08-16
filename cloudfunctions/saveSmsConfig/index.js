// saveSmsConfig — 保存短信全局配置（owner）
// 字段：signName / templateId / smsSdkAppId / secretId / secretKey / noticeTemplate
// 仅覆盖非空字段，避免误清空已配置的密钥。
const { db, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可配置')

  const doc = await db.collection('config_sms').doc('sms').get().catch(() => ({ data: null }))
  const cur = doc.data || {}
  const next = Object.assign({}, cur)

  if (event.signName) next.signName = String(event.signName).slice(0, 30)
  if (event.templateId) next.templateId = String(event.templateId).slice(0, 60)
  if (event.smsSdkAppId) next.smsSdkAppId = String(event.smsSdkAppId).slice(0, 60)
  if (event.secretId) next.secretId = String(event.secretId).slice(0, 80)
  if (event.secretKey) next.secretKey = String(event.secretKey).slice(0, 120)
  if (typeof event.noticeTemplate === 'string') next.noticeTemplate = event.noticeTemplate.slice(0, 200)
  next.updatedAt = Date.now()

  if (cur._id) {
    await db.collection('config_sms').doc('sms').update({ data: next })
  } else {
    await db.collection('config_sms').add({ data: Object.assign({ _id: 'sms' }, next) })
  }
  return ok({ saved: true })
}
