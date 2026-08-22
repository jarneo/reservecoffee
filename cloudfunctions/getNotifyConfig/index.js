// getNotifyConfig — 读取全局通知配置（owner）
// 返回 config 集合的 subscribe（订阅消息）与 mp（服务号）文档。
const { db, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可查看')

  const sub = await db.collection('config').doc('subscribe').get().catch(() => ({ data: null }))
  const mp = await db.collection('config').doc('mp').get().catch(() => ({ data: null }))
  return ok({
    subscribe: sub.data || {},
    mp: mp.data || {}
  })
}
