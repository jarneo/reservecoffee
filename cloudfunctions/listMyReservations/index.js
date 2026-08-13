// listMyReservations — 顾客端「我的预约」（返回五态有效状态）
const { db, COL, ok, wxCtx } = require('./lib')

function effStatus(r) {
  if (r.status === 'cancelled') return 'cancelled'
  if (r.status === 'completed') return 'completed'
  const end = new Date(`${r.date} ${r.sessionEnd || '23:59'}`)
  if (end < new Date()) return 'expired'
  return r.status // pending | confirmed
}

exports.main = async () => {
  const { OPENID } = wxCtx()
  if (!OPENID) return ok({ list: [] })

  const res = await db.collection(COL.reservations)
    .where({ openid: OPENID })
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get()

  // 关联项目名称
  const projIds = [...new Set((res.data || []).map(r => r.projectId))]
  const projs = await db.collection(COL.projects)
    .where({ _id: db.command.in(projIds) }).get()
  const nameMap = {}
  projs.data.forEach(p => { nameMap[p._id] = p.name })

  const list = (res.data || []).map(r => ({
    _id: r._id,
    projectId: r.projectId,
    projectName: nameMap[r.projectId] || '',
    date: r.date,
    time: `${r.sessionStart || ''}–${r.sessionEnd || ''}`,
    partySize: r.partySize,
    name: r.name,
    status: effStatus(r),
    review: r.review,
    canCancel: ['pending', 'confirmed'].includes(effStatus(r))
  }))

  return ok({ list })
}
