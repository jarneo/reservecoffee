// getAiLogs — 读取 AI 对话记录（aiLogs 集合），owner/manager 可见
// 支持分页 + 意图筛选 + 关键词(昵称/提问/回答) + 日期区间，供店主复盘对话、完善知识库与回答。
const { db, _, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (!role || !['owner', 'manager'].includes(role.role)) return fail('无权限')

  const page = Math.max(1, Number(event && event.page) || 1)
  const size = 50
  const skip = (page - 1) * size

  const ands = []
  // 意图筛选：all / chat(问答) / ask(追问) / confirm(确认预约)
  const intent = event && event.intent
  if (intent && intent !== 'all') ands.push({ intent })

  // 日期区间（按 createdAt，北京时间）
  const from = event && event.from
  const to = event && event.to
  if (from || to) {
    const range = {}
    if (from) range.$gte = new Date(from + 'T00:00:00+08:00')
    if (to) range.$lte = new Date(to + 'T23:59:59+08:00')
    ands.push({ createdAt: range })
  }

  // 关键词：昵称 / 用户提问 / 小曜回答 任一包含
  const kw = event && event.keyword && String(event.keyword).trim()
  if (kw) {
    const rx = db.RegExp({ regexp: kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' })
    ands.push(_.or([{ nickname: rx }, { input: rx }, { output: rx }]))
  }

  const where = ands.length ? (ands.length === 1 ? ands[0] : _.and(ands)) : {}

  const res = await db.collection('aiLogs').where(where).orderBy('createdAt', 'desc').skip(skip).limit(size).get().catch(() => ({ data: [] }))
  const rows = (res.data || []).map(r => ({
    _id: r._id,
    openid: r.openid || '',
    nickname: r.nickname || '',
    input: r.input || '',
    output: r.output || '',
    intent: r.intent || 'chat',
    slots: r.slots || null,
    model: r.model || '',
    tokens: r.tokens != null ? r.tokens : null,
    cost: r.cost != null ? r.cost : null,
    latencyMs: r.latencyMs != null ? r.latencyMs : null,
    createdAt: r.createdAt || null
  }))

  return ok({ list: rows, page, hasMore: rows.length === size })
}
