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
  //            booked(预约成功) —— 不是独立意图，而是该确认轮被 createReservation 回写 booked=true
  const intent = event && event.intent
  if (intent && intent !== 'all') {
    if (intent === 'booked') ands.push({ booked: true })
    else ands.push({ intent })
  }

  // 来源渠道筛选：all / mp(小程序) / oa(公众号)
  // ⚠️ 历史数据没有 channel 字段：选「小程序」时需带上「无此字段」的旧记录，否则早期对话会凭空消失。
  //    用 `channel in ['mp', null]` 无法命中「字段不存在」的文档，故改为：oa 用等值筛选，mp 用「不等于 oa」。
  const channel = event && event.channel
  if (channel && channel !== 'all') {
    if (channel === 'oa') ands.push({ channel: 'oa' })
    else ands.push({ channel: _.neq('oa') })
  }

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

  // 集合不存在（尚未产生对话 / 未创建）时返回空列表，但打日志便于区分「没数据」还是「查失败」
  const res = await db.collection('aiLogs').where(where).orderBy('createdAt', 'desc').skip(skip).limit(size).get()
    .catch(e => { console.warn('[getAiLogs] query failed:', e && (e.message || e.errMsg || e)); return { data: [] } })
  const rows = (res.data || []).map(r => ({
    _id: r._id,
    openid: r.openid || '',
    // 来源渠道：mp=小程序 / oa=公众号（历史数据无该字段 → 归 mp）
    channel: r.channel === 'oa' ? 'oa' : 'mp',
    unionid: r.unionid || '',
    nickname: r.nickname || '',
    input: r.input || '',
    output: r.output || '',
    intent: r.intent || 'chat',
    booked: r.booked === true,
    reservationId: r.reservationId || '',
    slots: r.slots || null,
    model: r.model || '',
    tokens: r.tokens != null ? r.tokens : null,
    cost: r.cost != null ? r.cost : null,
    latencyMs: r.latencyMs != null ? r.latencyMs : null,
    createdAt: r.createdAt || null
  }))

  return ok({ list: rows, page, hasMore: rows.length === size })
}
