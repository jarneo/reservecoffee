// cancelReservation — 顾客/管理员取消预约（释放名额 + 双轴置 cancelled）
const { db, _, COL, TPL, ok, fail, wxCtx, sendSubscribe } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('无法识别用户身份')
  const { reservationId } = event
  if (!reservationId) return fail('缺少 reservationId')

  const rRes = await db.collection(COL.reservations).doc(reservationId).get().catch(() => ({ data: null }))
  const r = rRes.data
  if (!r) return fail('预约不存在')
  // 仅本人可取消
  if (r.openid !== OPENID) return fail('无权取消该预约')

  const eff = (() => {
    if (r.status === 'cancelled') return 'cancelled'
    if (r.status === 'completed') return 'completed'
    const end = new Date(`${r.date} ${r.sessionEnd || '23:59'}`)
    if (end < new Date()) return 'expired'
    return r.status
  })()
  if (eff !== 'pending' && eff !== 'confirmed') return fail('该预约当前不可取消')

  const transaction = await db.startTransaction()
  try {
    await transaction.collection(COL.reservations).doc(reservationId).update({
      data: { status: 'cancelled', reviewedAt: Date.now() }
    })
    // 释放名额
    const sch = await transaction.collection(COL.schedules).where({ _id: r.scheduleId }).get()
    if (sch.data[0]) {
      const s = sch.data[0]
      const idx = (s.sessions || []).findIndex(x => x.id === r.sessionId)
      if (idx >= 0) {
        s.sessions[idx].booked = Math.max(0, s.sessions[idx].booked - r.partySize)
        await transaction.collection(COL.schedules).doc(s._id).update({ data: { sessions: s.sessions } })
      }
    }
    await transaction.commit()
    await sendSubscribe({ openid: r.openid, templateId: TPL.reserveCancel, data: {}, page: 'pages/mine/mine' })
    return ok({ id: reservationId, status: 'cancelled' })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '取消失败')
  }
}
