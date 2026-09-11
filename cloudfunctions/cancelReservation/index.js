// cancelReservation — 顾客/管理员取消预约（释放名额 + 双轴置 cancelled）
// 通知：① 顾客「预约取消」订阅消息（管理员代取消时顾客同样收到）
//      ② 管理员「预约取消」订阅消息（owner + manager）
//      ③ 顾客取消短信（cancel 模板 2729679）：本函数只落「延迟计划」（smsCancelAt），
//         实际发送由已装短信 SDK 的 remindReservation 定时补发，并在发前复校该预约仍为 cancelled；
//         若 skipSmsIfWxOk 开启且顾客的微信订阅卡片已送达，则不再安排短信（微信优先降级）
const { db, _, COL, TPL, ok, fail, wxCtx, getRole, monthDay, getStoreName,
  sendSubscribe, notifyAdmins, loadSubscribeSwitch, subOn, loadSmsSwitch, shouldSkipSms, effStatus } = require('./lib')

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

  // ⚠️ 过期判定必须走共享库 effStatus（内部按北京时间 Date.UTC−8h 还原真实时刻）。
  //    切勿用 `new Date(\`${r.date} ${r.sessionEnd}\`)`——容器时区是 UTC，会把结束时刻
  //    整体后移 8 小时，导致顾客可在场次结束后 8 小时内误取消/误释放名额。
  const eff = effStatus(r)
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
    const p = pRes.data || {}
    const pName = p.name || '预约'
    const subCfg = await loadSubscribeSwitch(db)
    const storeName = await getStoreName(db)
    const dt = `${monthDay(r.date)} ${r.sessionStart}-${r.sessionEnd}`

    // A 线 · 顾客取消（订阅）：管理员代顾客取消时同样发给顾客
    let cancelNotify = null
    if (subOn(subCfg, 'reserveCancel')) cancelNotify = await sendSubscribe({ openid: r.openid, templateId: TPL.reserveCancel, data: {
      thing1: { value: pName },
      time9: { value: `${r.date} ${r.sessionStart}` },
      thing5: { value: '期待下次为您留座～' }
    }, page: 'pages/mine/mine' })

    // B 线 · 管理员取消（订阅）：含联系方式
    let adminNotify = null
    if (subOn(subCfg, 'adminCancel')) adminNotify = await notifyAdmins(db, {
      templateId: TPL.adminCancel,
      data: {
        thing5: { value: pName },
        thing1: { value: r.name },
        time4: { value: `${r.date} ${r.sessionStart}` },
        phone_number2: { value: r.phone || '' }
      },
      page: 'pages/admin/hub/hub'
    })

    // C 线 · 顾客取消短信（延迟发 + 发送前复校；微信已送达则降级不发）
    const patch = { cancelNotify, adminNotify }
    try {
      const smsSw = await loadSmsSwitch(db)
      const cancelOn = smsSw.cancel !== false
      const wxDelivered = shouldSkipSms(smsSw, cancelNotify)
      if (!cancelOn) {
        patch.cancelSmsPlan = { skipped: true, reason: 'global switch off' }
      } else if (!p.smsEnabled) {
        patch.cancelSmsPlan = { skipped: true, reason: 'project sms off' }
      } else if (!r.phone) {
        patch.cancelSmsPlan = { skipped: true, reason: 'no phone' }
      } else if (wxDelivered) {
        patch.cancelSmsPlan = { skipped: true, reason: 'wx subscribe delivered (skipSmsIfWxOk)' }
      } else {
        // 仅校验「是否已配置取消模板」（直读 config_sms，不需要短信 SDK——真正发送由 remindReservation 承担）
        const cs = await db.collection('config_sms').doc('sms').get().catch(() => ({ data: null }))
        const tid = (cs && cs.data && cs.data.templates) ? cs.data.templates.cancel : ''
        if (!tid) {
          patch.cancelSmsPlan = { skipped: true, reason: 'no cancel template' }
        } else {
          // 延迟到点由 remindReservation 补发（15 分钟精度足够；发前复校预约仍为 cancelled）
          const delay = typeof smsSw.cancelDelay === 'number' ? smsSw.cancelDelay : 3
          patch.smsCancelSent = false
          patch.smsCancelAt = Date.now() + delay * 60000
          patch.cancelSmsPlan = { scheduledIn: delay }
        }
      }
    } catch (e) { console.warn('[cancelReservation] cancel sms plan failed (ignored):', e.message) }
    await db.collection(COL.reservations).doc(reservationId).update({ data: patch }).catch(() => {})

    return ok({ id: reservationId, status: 'cancelled' })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '取消失败')
  }
}
