// exportData — 按日期区间导出预约明细 + 访问统计（owner），返回 CSV 文本
const { db, _, COL, ok, fail, wxCtx, getRole } = require('./lib')

// CSV 单元格转义：含逗号/引号/换行的字段加双引号，内部双引号转义为 ""（避免姓名/回答含逗号时错位）
function escCell(v) {
  const s = String(v == null ? '' : v)
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可导出')

  // AI 对话记录导出（owner）
  if (event.type === 'ai') return exportAi(event)

  const { from, to } = event
  if (!from || !to) return fail('缺少日期区间')

  const res = await db.collection(COL.reservations)
    .where({ date: db.command.and(db.command.gte(from), db.command.lte(to)) })
    .orderBy('date', 'asc').limit(1000).get()

  const projIds = [...new Set((res.data || []).map(r => r.projectId))]
  const projs = await db.collection(COL.projects).where({ _id: db.command.in(projIds) }).get()
  const nameMap = {}
  projs.data.forEach(p => { nameMap[p._id] = p.name })

  const rows = (res.data || []).map(r => ({
    date: r.date,
    project: nameMap[r.projectId] || '',
    time: `${r.sessionStart || ''}-${r.sessionEnd || ''}`,
    name: r.name,
    phone: r.phone,
    partySize: r.partySize,
    status: r.status,
    review: r.review
  }))

  const header = '日期,项目,时段,姓名,手机号,人数,状态,审核'
  const csv = [header].concat(rows.map(r => [r.date, r.project, r.time, r.name, r.phone, r.partySize, r.status, r.review].map(escCell).join(','))).join('\n')

  return ok({ csv, count: rows.length })
}

// AI 对话记录导出：按日期区间导出 aiLogs 为 CSV（时间/昵称/openid/意图/提问/回答/模型/tokens/成本/耗时）
async function exportAi(event) {
  const bj = ts => new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const from = event.from || bj(Date.now() - 30 * 86400000)
  const to = event.to || bj(Date.now())
  const where = { createdAt: { $gte: new Date(from + 'T00:00:00+08:00'), $lte: new Date(to + 'T23:59:59+08:00') } }
  // 来源渠道筛选：all / mp(小程序) / oa(公众号)。历史数据无 channel 字段 → 归 mp（用「不等于 oa」命中）
  if (event.channel && event.channel !== 'all') {
    where.channel = (event.channel === 'oa') ? 'oa' : _.neq('oa')
  }
  const res = await db.collection('aiLogs').where(where).orderBy('createdAt', 'asc').limit(1000).get().catch(() => ({ data: [] }))
  const fmtTs = ts => {
    if (!ts) return ''
    const ms = (ts instanceof Date) ? ts.getTime() : Date.parse(ts)
    if (isNaN(ms)) return ''
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
  }
  const rows = (res.data || []).map(r => ({
    t: fmtTs(r.createdAt),
    nick: r.nickname || '',
    openid: r.openid || '',
    // 来源渠道：公众号 AI / 小程序 AI（历史数据无该字段 → 归小程序）
    chan: r.channel === 'oa' ? '公众号' : '小程序',
    intent: r.intent || 'chat',
    // 预约成功：该轮对话最终是否真的转成预约单（confirm 轮被 createReservation 回写 booked=true）
    booked: r.booked === true ? '是' : '否',
    input: (r.input || '').replace(/[\r\n]+/g, ' '),
    output: (r.output || '').replace(/[\r\n]+/g, ' '),
    model: r.model || '',
    tokens: r.tokens != null ? r.tokens : '',
    cost: r.cost != null ? r.cost : '',
    ms: r.latencyMs != null ? r.latencyMs : ''
  }))
  const header = '时间,来源渠道,昵称,openid,意图,是否预约成功,用户提问,小曜回答,模型,tokens,成本(元),耗时(ms)'
  const csv = [header].concat(rows.map(r => [r.t, r.chan, r.nick, r.openid, r.intent, r.booked, r.input, r.output, r.model, r.tokens, r.cost, r.ms].map(escCell).join(','))).join('\n')
  return ok({ csv, count: rows.length })
}
