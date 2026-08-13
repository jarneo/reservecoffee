// listReviews — 列出待审核预约（owner），供审核页使用
const { db, _, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可审核')

  const res = await db.collection(COL.reservations)
    .where({ review: 'pending', status: 'pending' })
    .orderBy('createdAt', 'asc').limit(200).get()

  const ids = [...new Set((res.data || []).map(r => r.projectId))]
  const projs = await db.collection(COL.projects).where({ _id: db.command.in(ids) }).get()
  const nm = {}
  projs.data.forEach(p => { nm[p._id] = p.name })

  const list = (res.data || []).map(r => ({
    _id: r._id, name: r.name, phone: r.phone, partySize: r.partySize,
    projectName: nm[r.projectId] || '', date: r.date,
    time: `${r.sessionStart || ''}-${r.sessionEnd || ''}`, note: r.note || ''
  }))
  return ok({ list })
}
