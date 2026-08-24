// reviewReservation — 审核通过/拒绝（owner）
const { db, COL, TPL, ok, fail, wxCtx, getRole, monthDay, getStoreName, sendSubscribe, notifyAdmins } = require('./lib')
const { sendTemplateSms, loadConfig, buildSmsParams } = require('./sms')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('仅管理员可审核')

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

    // 项目信息 + 店铺名（提前读取，修复 p 作用域隐患）
    const pRes = await db.collection(COL.projects).doc(r.projectId).get().catch(() => ({ data: null }))
    const p = pRes.data
    const storeName = await getStoreName(db)
    const dt = `${monthDay(r.date)} ${r.sessionStart}-${r.sessionEnd}`

    // 审核通过 → 短信通知「已为您留座」（全局开关 + 项目开关 双重控制，仅预订人）
    if (decision === 'approve' && p && p.smsEnabled) {
      try {
        const smsSwRes = await db.collection('config').doc('smsnotify').get().catch(() => ({ data: null }))
        const sw = smsSwRes && smsSwRes.data ? smsSwRes.data : {}
        if (sw.success !== false) {
          const smsApp = await loadConfig(db)
          const tid = smsApp && smsApp.templates && smsApp.templates.success
          if (tid) {
            await sendTemplateSms({
              db, phone: r.phone, templateId: tid,
              params: buildSmsParams('success', {
                name: r.name, date: monthDay(r.date),
                time: `${r.sessionStart}-${r.sessionEnd}`, seats: `${r.partySize}人位`
              })
            })
          }
        }
      } catch (e) { console.warn('[reviewReservation] sms failed (ignored):', e.message) }
    }

    // 审核通过 → 推送「预约成功」给顾客（小程序订阅）
    if (decision === 'approve') {
      await sendSubscribe({
        openid: r.openid,
        templateId: TPL.reserveSuccess,
        data: {
          thing10: { value: p.name },
          time12: { value: `${r.date} ${r.sessionStart}` },
          thing6: { value: `${r.partySize}人位` },
          thing9: { value: '已为您留座，请准时光临，期待与您相见～' }
        },
        page: 'pages/mine/mine'
      })
    }
    // 拒绝：不发送订阅消息（顾客在「我的预约」查看状态）

    // 审核结果 → 推送「待审核提醒」给管理员（owner+manager），闭环审核流
    // thing1 前缀标注结果（已通过/已拒绝），thing 类型上限 20 字，安全
    await notifyAdmins(db, {
      templateId: TPL.adminReview,
      data: {
        thing5: { value: p.name },
        thing1: { value: `${decision === 'approve' ? '已通过 ' : '已拒绝 '}${r.name}` },
        time4: { value: `${r.date} ${r.sessionStart}` },
        phone_number2: { value: r.phone }
      },
      page: 'pages/admin/review/review'
    }).catch(() => {})

    return ok({ decision, status: decision === 'approve' ? 'confirmed' : 'cancelled' })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '审核失败')
  }
}
