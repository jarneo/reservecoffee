// getAiConfig — 读取 AI 智能预约配置
//   · 总开关 enabled
//   · 快捷短语 quickReplies / 开场白 greeting
//   · 公众号 AI 助理开关 oaEnabled
//   · 每用户每日对话轮次上限 dailyTurnLimit / oaDailyTurnLimit（0 = 不限）、超限话术 limitReply
//   · 小程序卡片封面素材 cardThumbMediaId（存于 config.mp，供 mpChat 发卡片用）
// ⚠️ 说明：快捷短语需由「顾客端 AI 页」读取后渲染输入框上方的按钮，故本函数不限定 owner
//    （返回内容仅为开关与引导话术，无敏感信息；写入仍由 saveAiConfig 严格限定 owner）。
const { db, ok, normalizeAiLimits } = require('./lib')

// 内置默认快捷短语：后台未配置时使用（与旧版硬编码的三条保持一致）
const DEFAULT_QUICK = [
  { label: '明天·法兰绒', text: '明天两点，两人，法兰绒深烘' },
  { label: '清酒品鉴', text: '清酒品鉴怎么约？' },
  { label: '到店引导', text: '你们家怎么走？营业到几点？' }
]

// 内置默认开场白：后台未配置时使用（与前端 ai.js 的 DEFAULT_GREETING 保持一致）
const DEFAULT_GREETING = '我是二曜路8号咖啡清酒的AI预约助理小曜。任何关于店铺预约、菜单、价格等问题都可以直接问我哦。如果您要预约，试着说"明天两点，2位，深烘法兰绒咖啡"；如果您要咨询店铺的其他问题，也可以直接问我哦。'

exports.main = async () => {
  const r = await db.collection('config').doc('ai').get().catch(() => ({ data: null }))
  const d = r.data || {}
  const list = Array.isArray(d.quickReplies) ? d.quickReplies : []
  const quick = list
    .filter(x => x && typeof x.label === 'string' && typeof x.text === 'string' && x.label.trim() && x.text.trim())
    .slice(0, 6)
    .map(x => ({ label: x.label.trim(), text: x.text.trim() }))
  // 后台未配置（或全是空项）时回落到内置默认，保证「不配置也和以前一样」
  const greeting = (typeof d.greeting === 'string' && d.greeting.trim()) ? d.greeting.trim() : DEFAULT_GREETING

  // 轮次上限：后台未配置时用共享库默认值（normalizeAiLimits 负责兜底）
  const lim = normalizeAiLimits(d)
  // oaDailyTurnLimit 未单独设置时返回 ''，前端显示「沿用上方」而不是把默认值写死进后台
  const oaSet = (typeof d.oaDailyTurnLimit === 'number' && isFinite(d.oaDailyTurnLimit) && d.oaDailyTurnLimit >= 0)

  // 小程序卡片封面素材（公众号 AI 发卡片用），存于 config.mp
  const mp = await db.collection('config').doc('mp').get().catch(() => ({ data: null }))
  const cardThumbMediaId = (mp && mp.data && mp.data.cardThumbMediaId) || ''

  return ok({
    enabled: d.enabled !== false,
    quickReplies: quick.length ? quick : DEFAULT_QUICK,
    greeting,
    oaEnabled: d.oaEnabled !== false,
    dailyTurnLimit: lim.dailyTurnLimit,
    oaDailyTurnLimit: oaSet ? Math.floor(d.oaDailyTurnLimit) : '',
    limitReply: (typeof d.limitReply === 'string' && d.limitReply.trim()) ? d.limitReply.trim() : '',
    cardThumbMediaId
  })
}
