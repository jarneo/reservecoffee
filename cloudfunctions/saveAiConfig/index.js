// saveAiConfig — 保存 AI 智能预约配置（owner）
//   enabled            总开关；关闭后首页/详情页浮窗与 AI 入口整块隐藏（ai-reserve-spec.md §15）
//   quickReplies       AI 页输入框上方的快捷短语 [{label,text}]，点一下即发送 text（最多 6 条）
//   greeting           开场白（留空则前端回落内置默认）
//   oaEnabled          公众号 AI 助理开关（关闭后 mpChat 仍会收消息，但直接返回不回 AI）
//   dailyTurnLimit     每用户每天 AI 对话轮次上限（0 = 不限；缺省 30）
//   oaDailyTurnLimit   公众号渠道单独上限（不传 / null = 沿用 dailyTurnLimit）
//   limitReply         超限时的话术（留空用内置默认）
//   cardThumbMediaId   小程序卡片封面素材 media_id（写入 config.mp，供 mpChat 发卡片）
const { db, ok, fail, wxCtx, getRole, normalizeAiLimits } = require('./lib')

const MAX_QUICK = 6
const MAX_LABEL = 8     // 按钮文字上限（按钮宽度有限）
const MAX_TEXT = 60     // 发送话术上限
const MAX_GREETING = 200 // 开场白上限
const MAX_TURN = 999    // 轮次上限最大值（防御性上限）
const MAX_LIMIT_REPLY = 200

// 轮次上限：必须是 0–MAX_TURN 的整数；0 表示不限制
function normLimit(v) {
  if (v === '' || v === null || v === undefined) return null // 未设置
  const n = Number(v)
  if (!isFinite(n) || n < 0) return null
  return Math.min(Math.floor(n), MAX_TURN)
}

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
    data.greeting = event.greeting.trim().slice(0, MAX_GREETING)
  }

  // 公众号 AI 助理开关
  if (event.oaEnabled !== undefined) {
    if (typeof event.oaEnabled !== 'boolean') return fail('参数错误：oaEnabled 必须为布尔')
    data.oaEnabled = event.oaEnabled
  }

  // 每用户每日轮次上限（0 = 不限）
  if (event.dailyTurnLimit !== undefined) {
    const n = normLimit(event.dailyTurnLimit)
    if (n === null) return fail('参数错误：每日轮次上限必须是 0–999 的整数（0 表示不限）')
    data.dailyTurnLimit = n
  }
  // 公众号单独上限：传 null / '' 表示「沿用上方」，需显式清掉该字段
  if (event.oaDailyTurnLimit !== undefined) {
    const n = normLimit(event.oaDailyTurnLimit)
    data.oaDailyTurnLimit = (n === null) ? null : n
  }
  if (event.limitReply !== undefined) {
    if (typeof event.limitReply !== 'string') return fail('参数错误：超限话术必须为字符串')
    data.limitReply = event.limitReply.trim().slice(0, MAX_LIMIT_REPLY)
  }

  const col = db.collection('config')
  const ex = await col.doc('ai').get().catch(() => ({ data: null }))
  if (ex.data) await col.doc('ai').update({ data })
  else await col.doc('ai').set({ data })

  // 小程序卡片封面素材写入 config.mp（与公众号其它配置同文档，单一真相）
  if (event.cardThumbMediaId !== undefined) {
    if (typeof event.cardThumbMediaId !== 'string') return fail('参数错误：封面素材 ID 必须为字符串')
    const tid = event.cardThumbMediaId.trim().slice(0, 200)
    const mpEx = await col.doc('mp').get().catch(() => ({ data: null }))
    if (mpEx.data) await col.doc('mp').update({ data: { cardThumbMediaId: tid } })
    else await col.doc('mp').set({ data: { cardThumbMediaId: tid } })
  }

  const lim = normalizeAiLimits(Object.assign({}, ex.data || {}, data))
  return ok({
    saved: true,
    enabled: data.enabled,
    quickReplies: data.quickReplies || [],
    greeting: data.greeting || '',
    dailyTurnLimit: lim.dailyTurnLimit,
    oaDailyTurnLimit: data.oaDailyTurnLimit,
    limitReply: data.limitReply || ''
  })
}
