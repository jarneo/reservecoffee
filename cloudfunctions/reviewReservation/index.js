// reviewReservation — 审核通过/拒绝（owner）
const { db, COL, TPL, ok, fail, wxCtx, getRole, sendSubscribe } = require('./lib')
const { sendReservationSms } = require('./sms')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可审核')

  const { reservationId, decision } = event
  if (!reservationId || !['approve', 'reject'].includes(decision)) return fail('参数缺失')

  const rRes = await db.collection(COL.reservations).doc(reservationId).get().catch(() => ({ data: null }))
  const r = rRes.data
  if (!r) return fail('预约不存在')
  if (r.review !== 'pending') return fail('该预约无须审核或已处理')

  const transaction = await db.startTransaction()
  try {
    if (decision === 'approve') {
      await transaction.collection(COL.reservations).doc(reservationId).update({
        data: { review: 'approved', status: 'confirmed', reviewedAt: Date.now() }
      })
    } else {
      // 拒绝：置 cancelled 并释放名额
      await transaction.collection(COL.reservations).doc(reservationId).update({
        data: { review: 'rejected', status: 'cancelled', reviewedAt: Date.now() }
      })
      const sch = await transaction.collection(COL.schedules).where({ _id: r.scheduleId }).get()
      if (sch.data[0]) {
        const s = sch.data[0]
        const idx = (s.sessions || []).findIndex(x => x.id === r.sessionId)
        if (idx >= 0) {
          s.sessions[idx].booked = Math.max(0, s.sessions[idx].booked - r.partySize)
          await transaction.collection(COL.schedules).doc(s._id).update({ data: { sessions: s.sessions } })
        }
      }
    }
    await transaction.commit()

    // 审核通过 → 短信通知「预约成功」（每项目独立开关）
    if (decision === 'approve') {
      const pRes = await db.collection(COL.projects).doc(r.projectId).get().catch(() => ({ data: null }))
      const p = pRes.data
      if (p && p.smsEnabled) {
        sendReservationSms({
          db, phone: r.phone, name: r.name, project: p.name,
          date: r.date, time: `${r.sessionStart}–${r.sessionEnd}`,
          status: 'confirmed', notice: p.smsNotice
        }).catch(() => {})
      }
    }

    await sendSubscribe({
      openid: r.openid, templateId: TPL.reviewResult,
      data: {}, page: 'pages/mine/mine'
    })
    return ok({ decision, status: decision === 'approve' ? 'confirmed' : 'cancelled' })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '审核失败')
  }
}
