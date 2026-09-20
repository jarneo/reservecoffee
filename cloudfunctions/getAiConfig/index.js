// getAiConfig — 读取 AI 智能预约总开关（owner）
// 返回 config.ai.enabled（缺省 true）
const { db, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可查看')
  const r = await db.collection('config').doc('ai').get().catch(() => ({ data: null }))
  const d = r.data || {}
  return ok({ enabled: d.enabled !== false })
}
