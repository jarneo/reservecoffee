// reviewAllReservations — 批量审核通过所有待审核预约（owner/manager）
// 与 reviewReservation 单条逻辑等价：逐条事务改状态 + 成功短信 + 预约成功/审核结果订阅，并汇总结果。
// ⚠️ 单条审核逻辑与 reviewReservation/index.js 保持同步；后者改动时本函数须同步。
const { db, _, COL, TPL, ok, fail, wxCtx, getRole, monthDay, getStoreName, sendSubscribe, notifyAdmins } = require('./lib')
const { sendTemplateSms, loadConfig } = require('./sms')

// 处理单条待审核预约（与 reviewReservation 内部逻辑一致）
async function processOne(reservationId, decision) {
  const rRes = await db.collection(COL.reservations).doc(reservationId).get().catch(() => ({ data: null }))
  const r = rRes.data
  if (!r) return { ok: false, reservationId, reason: 'not found' }
  if (r.review !== 'pending') return { ok: false, reservationId, reason: 'not pending' }

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

    // 项目信息（用于通知文案）
    const pRes = await db.collection(COL.projects).doc(r.projectId).get().catch(() => ({ data: null }))
    const p = pRes.data

    // 审核通过 → 短信「已为您留座」（全局开关 + 项目开关 双重控制，仅预订人）
    if (decision === 'approve' && p && p.smsEnabled) {
      try {
        const smsSwRes = await db.collection('config').doc('smsnotify').get().catch(() => ({ data: null }))
        const sw = smsSwRes && smsSwRes.data ? smsSwRes.data : {}
        if (sw.success !== false) {
          const smsApp = await loadConfig(db)
          const tid = smsApp && smsApp.templates && smsApp.templates.success
          if (tid) {
            const delay = typeof sw.successDelay === 'number' ? sw.successDelay : 0
            if (delay <= 0) {
              await sendTemplateSms({ db, phone: r.phone, templateId: tid })
              await db.collection(COL.reservations).doc(reservationId).update({ data: { smsSuccessSent: true } }).catch(() => {})
            } else {
              await db.collection(COL.reservations).doc(reservationId).update({
                data: { smsSuccessSent: false, smsSuccessAt: Date.now() + delay * 60000 }
              }).catch(() => {})
            }
          }
        }
      } catch (e) { console.warn('[reviewAll] sms failed (ignored):', e.message) }
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

    // 审核结果 → 推送「待审核提醒」给管理员（owner+manager），闭环审核流
    const adminReviewData = {
      thing1: { value: p.name },
      time2: { value: `${r.date} ${r.sessionStart}` },
      number3: { value: r.partySize }
    }
    const adminNotifyReview = await notifyAdmins(db, {
      templateId: TPL.adminReview,
      data: adminReviewData,
      page: 'pages/admin/review/review'
    }).catch(e => { console.warn('[reviewAll] notifyAdmins failed:', e && e.message); return [{ ok: false, err: e && e.message }] })
    try { await db.collection(COL.reservations).doc(reservationId).update({ data: { adminNotifyReview } }) } catch (e) {}

    return { ok: true, reservationId, decision }
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return { ok: false, reservationId, reason: e.message || 'failed' }
  }
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('仅管理员可审核')

  const decision = ['approve', 'reject'].includes(event.decision) ? event.decision : 'approve'

  // 与 listReviews 一致：所有待审核且状态仍为 pending 的预约 = 审核页可见的待审列表
  const res = await db.collection(COL.reservations)
    .where({ review: 'pending', status: 'pending' })
    .orderBy('createdAt', 'asc').limit(200).get()
  const pending = res.data || []

  let approved = 0, skipped = 0, failed = 0
  const errors = []
  for (const r of pending) {
    const out = await processOne(r._id, decision)
    if (out.ok) approved++
    else if (out.reason === 'not pending') skipped++
    else { failed++; errors.push({ id: r._id, reason: out.reason }) }
  }
  return ok({ total: pending.length, approved, skipped, failed, errors })
}
