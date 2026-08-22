// cancelReservation — 顾客/管理员取消预约（释放名额 + 双轴置 cancelled）
const { db, _, COL, TPL, ok, fail, wxCtx, getRole, monthDay, getStoreName, sendSubscribe, notifyAdmins } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('无法识别用户身份')
  const { reservationId } = event
  if (!reservationId) return fail('缺少 reservationId')

  const role = await getRole(OPENID)
  const rRes = await db.collection(COL.reservations).doc(reservationId).get().catch(() => ({ data: null }))
  const r = rRes.data
  if (!r) return fail('预约不存在')
  // 管理员（owner/manager）可代取消任意预约；普通用户仅可取消自己的预约
  if (role.role !== 'owner' && role.role !== 'manager' && r.openid !== OPENID) {
    return fail('无权取消该预约')
  }

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

    // 项目名（门店）
    const pRes = await db.collection(COL.projects).doc(r.projectId).get().catch(() => ({ data: null }))
    const pName = (pRes.data && pRes.data.name) || '预约'
    const storeName = await getStoreName(db)
    const dt = `${monthDay(r.date)} ${r.sessionStart}-${r.sessionEnd}`

    // A 线 · 顾客取消（订阅）
    await sendSubscribe({ openid: r.openid, templateId: TPL.reserveCancel, data: {
      thing1: { value: pName },
      time9: { value: `${r.date} ${r.sessionStart}` },
      thing5: { value: '期待下次为您留座～' }
    }, page: 'pages/mine/mine' })

    // B 线 · 管理员取消（订阅）：含联系方式
    await notifyAdmins(db, {
      templateId: TPL.adminCancel,
      data: {
        thing5: { value: pName },
        thing1: { value: r.name },
        time4: { value: `${r.date} ${r.sessionStart}` },
        phone_number2: { value: r.phone || '' }
      },
      page: 'pages/admin/hub/hub'
    })

    return ok({ id: reservationId, status: 'cancelled' })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '取消失败')
  }
}
