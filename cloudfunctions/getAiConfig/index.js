// getAiConfig — 读取 AI 智能预约配置：总开关 enabled + 快捷短语 quickReplies
// ⚠️ 说明：快捷短语需由「顾客端 AI 页」读取后渲染输入框上方的按钮，故本函数不再限定 owner
//    （返回内容仅为开关与引导话术，无敏感信息；写入仍由 saveAiConfig 严格限定 owner）。
const { db, ok } = require('./lib')

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
  return ok({ enabled: d.enabled !== false, quickReplies: quick.length ? quick : DEFAULT_QUICK, greeting })
}
