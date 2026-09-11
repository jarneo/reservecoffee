// reviewReservation — 审核通过/拒绝（owner）
const { db, COL, TPL, ok, fail, wxCtx, getRole, monthDay, getStoreName, sendSubscribe, notifyAdmins, loadSubscribeSwitch, subOn, shouldSkipSms } = require('./lib')
const { sendTemplateSms, loadConfig } = require('./sms')

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
    const subCfg = await loadSubscribeSwitch(db)
    const storeName = await getStoreName(db)
    const dt = `${monthDay(r.date)} ${r.sessionStart}-${r.sessionEnd}`

    // 审核通过 → 推送「预约成功」给顾客（小程序订阅）
    // ⚠️ 必须在短信之前发送：其返回值决定「微信优先降级」是否跳过成功短信
    let wxSuccessRes = null
    if (decision === 'approve' && subOn(subCfg, 'reserveSuccess')) {
      wxSuccessRes = await sendSubscribe({
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

    // 审核通过 → 短信通知「已为您留座」（全局开关 + 项目开关 双重控制，仅预订人）
    // 成功短信延迟计划：successDelay<=0 立即发送；>0 延迟到点由 remindReservation 发送
    // 【微信优先降级】skipSmsIfWxOk 开启且订阅卡片已送达 → 不再发成功短信
    let smsSkipPatch = null
    if (decision === 'approve' && p && p.smsEnabled) {
      try {
        const smsSwRes = await db.collection('config').doc('smsnotify').get().catch(() => ({ data: null }))
        const sw = smsSwRes && smsSwRes.data ? smsSwRes.data : {}
        if (sw.success !== false) {
          const smsApp = await loadConfig(db)
          const tid = smsApp && smsApp.templates && smsApp.templates.success
          if (tid) {
            const delay = typeof sw.successDelay === 'number' ? sw.successDelay : 0
            if (shouldSkipSms(sw, wxSuccessRes)) {
              smsSkipPatch = { smsSuccessSent: true, smsResult: { skipped: true, reason: 'wx subscribe delivered (skipSmsIfWxOk)' } }
              await db.collection(COL.reservations).doc(reservationId).update({ data: smsSkipPatch }).catch(() => {})
            } else if (delay <= 0) {
              const sres = await sendTemplateSms({ db, phone: r.phone, templateId: tid })
              await db.collection(COL.reservations).doc(reservationId).update({
                data: { smsSuccessSent: !!(sres && sres.ok), smsResult: sres }
              }).catch(() => {})
            } else {
              await db.collection(COL.reservations).doc(reservationId).update({
                data: { smsSuccessSent: false, smsSuccessAt: Date.now() + delay * 60000 }
              }).catch(() => {})
            }
          }
        }
      } catch (e) { console.warn('[reviewReservation] sms failed (ignored):', e.message) }
    }

    // 记录微信订阅送达标记（供 remindReservation 的延迟成功短信降级判断）
    if (decision === 'approve') {
      try {
        await db.collection(COL.reservations).doc(reservationId).update({
          data: { wxSuccessOk: !!(wxSuccessRes && wxSuccessRes.ok && !wxSuccessRes.skipped) }
        })
      } catch (e) {}
    }

    // 审核结果 → 管理员推送：**「通过」与「拒绝」都不再通知管理员**（2026-09-12 按需求移除）。
    // 理由：① 审核是管理员本人的操作，再来一条推送纯属打扰；
    //       ② adminReview 模板是「待审核提醒」，用它播报「已通过 / 已拒绝」语义不符；
    //       ③ 「待审核提醒」在【下单时】已由 createReservation 发出（needReview 分支），审核环节无需再发。
    // 两个分支都落库 skipped 痕迹，便于日后排查「为什么没收到管理推送」（与 cancelSmsPlan.reason 同一约定）。
    const adminNotifyReview = { skipped: true, decision, reason: 'admin push disabled on review' }
    try { await db.collection(COL.reservations).doc(reservationId).update({ data: { adminNotifyReview } }) } catch (e) {}

    return ok({ decision, status: decision === 'approve' ? 'confirmed' : 'cancelled' })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '审核失败')
  }
}
