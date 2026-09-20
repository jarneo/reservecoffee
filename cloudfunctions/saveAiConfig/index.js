// saveAiConfig — 保存 AI 智能预约总开关（owner）
// 写入 config.ai.enabled；关闭后首页/详情页浮窗与 AI 入口整块隐藏（ai-reserve-spec.md §15）。
const { db, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可配置')
  if (typeof event.enabled !== 'boolean') return fail('参数错误：enabled 必须为布尔')

  const col = db.collection('config')
  const ex = await col.doc('ai').get().catch(() => ({ data: null }))
  if (ex.data) await col.doc('ai').update({ data: { enabled: event.enabled } })
  else await col.doc('ai').set({ data: { enabled: event.enabled } })
  return ok({ saved: true, enabled: event.enabled })
}
