// listSessionReservations — 查看某场次预约人（含联系方式，owner/manager）
const { db, _, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId, date, sessionId } = event
  if (!sessionId) return fail('缺少 sessionId')

  // 仅显示有效预约：未取消 + 未审核拒绝
  const where = {
    sessionId,
    status: _.in(['pending', 'confirmed']),
    review: _.neq('rejected')
  }
  if (projectId) where.projectId = projectId
  if (date) where.date = date

  const res = await db.collection(COL.reservations).where(where).orderBy('createdAt', 'asc').get()
  const list = (res.data || []).map(r => ({
    _id: r._id,
    name: r.name || '匿名顾客',
    phone: r.phone || '',
    partySize: r.partySize || 0,
    note: r.note || '',
    review: r.review || 'none',
    status: r.status || 'pending'
  }))
  return ok({ list })
}
