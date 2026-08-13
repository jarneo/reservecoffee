// exportData — 按日期区间导出预约明细 + 访问统计（owner），返回 CSV 文本
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可导出')

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
  const csv = [header].concat(rows.map(r => [r.date, r.project, r.time, r.name, r.phone, r.partySize, r.status, r.review].join(','))).join('\n')

  return ok({ csv, count: rows.length })
}
