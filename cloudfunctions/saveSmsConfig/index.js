// saveSmsConfig — 保存短信全局配置（owner）
// 字段：signName / smsSdkAppId / secretId / secretKey / noticeTemplate
//      templates{success,approaching,expired,cancel,dayBefore}
// 仅覆盖非空字段，避免误清空已配置的密钥。
const { db, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可配置')

  // 确保 config_sms 集合存在（CloudBase 写操作不会自动建集合；
  // 若此前仅靠环境变量发短信、集合从未创建，首次保存会抛 "Db or Table not exist"）
  try { await db.createCollection('config_sms') } catch (e) { /* 已存在/无权限则忽略 */ }

  const doc = await db.collection('config_sms').doc('sms').get().catch(() => ({ data: null }))
  const cur = doc.data || {}
  const next = Object.assign({}, cur)
  // ⚠️ CloudBase 的 update 不允许 data 中携带 _id，否则抛 INVALID_PARAM；删除后再更新
  delete next._id
  // ⚠️ 短信 API 地域固定为 ap-guangzhou（由 sms.js 内部处理），config_sms 里不应存 region，
  // 否则旧值（如 ap-shanghai）会误导且曾导致全部短信静默失败；此处主动丢弃该字段。
  delete next.region

  if (event.signName) next.signName = String(event.signName).slice(0, 30)
  if (event.smsSdkAppId) next.smsSdkAppId = String(event.smsSdkAppId).slice(0, 60)
  if (event.secretId) next.secretId = String(event.secretId).slice(0, 80)
  if (event.secretKey) next.secretKey = String(event.secretKey).slice(0, 120)
  if (typeof event.noticeTemplate === 'string') next.noticeTemplate = event.noticeTemplate.slice(0, 200)
  // 五个短信模板 ID（任意非空即覆盖对应项）
  const tpl = Object.assign({}, cur.templates || {})
  if (event.tplSuccess) tpl.success = String(event.tplSuccess).slice(0, 60)
  if (event.tplApproaching) tpl.approaching = String(event.tplApproaching).slice(0, 60)
  if (event.tplExpired) tpl.expired = String(event.tplExpired).slice(0, 60)
  if (event.tplCancel) tpl.cancel = String(event.tplCancel).slice(0, 60)
  if (event.tplDayBefore) tpl.dayBefore = String(event.tplDayBefore).slice(0, 60)
  next.templates = tpl
  next.updatedAt = Date.now()

  if (cur._id) {
    await db.collection('config_sms').doc('sms').update({ data: next })
  } else {
    await db.collection('config_sms').add({ data: Object.assign({ _id: 'sms' }, next) })
  }
  return ok({ saved: true })
}
