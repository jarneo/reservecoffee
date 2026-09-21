// saveAiConfig — 保存 AI 智能预约配置（owner）
//   enabled：总开关；关闭后首页/详情页浮窗与 AI 入口整块隐藏（ai-reserve-spec.md §15）
//   quickReplies：AI 页输入框上方的快捷短语 [{label,text}]，点一下即发送 text（最多 6 条）
const { db, ok, fail, wxCtx, getRole } = require('./lib')

const MAX_QUICK = 6
const MAX_LABEL = 8     // 按钮文字上限（按钮宽度有限）
const MAX_TEXT = 60     // 发送话术上限
const MAX_GREETING = 200 // 开场白上限

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可配置')
  if (typeof event.enabled !== 'boolean') return fail('参数错误：enabled 必须为布尔')

  const data = { enabled: event.enabled }

  if (event.quickReplies !== undefined) {
    if (!Array.isArray(event.quickReplies)) return fail('参数错误：quickReplies 必须为数组')
    data.quickReplies = event.quickReplies
      .filter(x => x && typeof x.label === 'string' && typeof x.text === 'string' && x.label.trim() && x.text.trim())
      .slice(0, MAX_QUICK)
      .map(x => ({ label: x.label.trim().slice(0, MAX_LABEL), text: x.text.trim().slice(0, MAX_TEXT) }))
  }

  // 开场白：非空则存储；为空字符串则清掉该字段，让顾客端回落到内置默认
  if (event.greeting !== undefined) {
    if (typeof event.greeting !== 'string') return fail('参数错误：greeting 必须为字符串')
    const g = event.greeting.trim().slice(0, MAX_GREETING)
    data.greeting = g
  }

  const col = db.collection('config')
  const ex = await col.doc('ai').get().catch(() => ({ data: null }))
  if (ex.data) await col.doc('ai').update({ data })
  else await col.doc('ai').set({ data })
  return ok({ saved: true, enabled: data.enabled, quickReplies: data.quickReplies || [], greeting: data.greeting || '' })
}
