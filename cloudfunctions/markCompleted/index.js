// markCompleted — 标记预约已完成（owner/manager）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { reservationId } = event
  if (!reservationId) return fail('缺少 reservationId')

  const rRes = await db.collection(COL.reservations).doc(reservationId).get().catch(() => ({ data: null }))
  const r = rRes.data
  if (!r) return fail('预约不存在')
  if (r.status !== 'confirmed') return fail('仅「预约成功」状态可标记完成')

  await db.collection(COL.reservations).doc(reservationId).update({
    data: { status: 'completed', reviewedAt: Date.now() }
  })
  return ok({ id: reservationId, status: 'completed' })
}
