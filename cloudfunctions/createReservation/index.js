// createReservation — 提交预约（事务防超卖 + 双轴状态）
const { db, _, COL, TPL, ok, fail, wxCtx, addDays, sendSubscribe } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('无法识别用户身份')

  const { projectId, date, sessionId, name, phone, partySize, note } = event
  if (!projectId || !date || !sessionId) return fail('参数缺失')
  if (!/^1[3-9]\d{9}$/.test(phone || '')) return fail('请填写正确的手机号')
  if (!name || !name.trim()) return fail('请填写称呼')
  const pSize = Number(partySize) || 1
  if (pSize < 1) return fail('预约人数无效')

  // 读项目配置
  const pRes = await db.collection(COL.projects).doc(projectId).get().catch(() => ({ data: null }))
  const p = pRes.data
  if (!p || !p.published) return fail('项目不存在或未发布')
  if (p.paused) return fail('该项目已暂停预约')

  const adv = Number(p.advanceDays) || 7
  if (!(adv >= 1 && adv <= 30)) return fail('项目可预约天数配置异常')
  if (!p.openDays || !p.openDays.includes(date)) return fail('该日期不可预约')
  if (date > addDays(adv)) return fail('超出可预约时间范围')

  const transaction = await db.startTransaction()
  try {
    const sch = await transaction.collection(COL.schedules)
      .where({ projectId, date }).get()
    const schedule = sch.data[0]
    if (!schedule) { await transaction.rollback(); return fail('该日期暂未设置场次') }

    const idx = (schedule.sessions || []).findIndex(s => s.id === sessionId)
    if (idx < 0) { await transaction.rollback(); return fail('场次不存在') }
    const session = schedule.sessions[idx]
    if (session.paused) { await transaction.rollback(); return fail('该场次已暂停预约') }
    if (session.capacity - session.booked < pSize) { await transaction.rollback(); return fail('该场次名额不足') }

    // 每日上限（按 openid+project+date 的有效预约）
    const daily = await transaction.collection(COL.reservations).where({
      openid: OPENID, projectId, date,
      status: _.in(['pending', 'confirmed']), review: _.neq('rejected')
    }).count()
    if (daily.total >= (p.dailyLimit || 1)) {
      await transaction.rollback(); return fail('今日该项目的预约次数已达上限')
    }

    // 重复预约同场次
    const dup = await transaction.collection(COL.reservations).where({
      openid: OPENID, projectId, date, sessionId,
      status: _.in(['pending', 'confirmed']), review: _.neq('rejected')
    }).count()
    if (dup.total > 0) { await transaction.rollback(); return fail('你已预约该场次') }

    // 占额
    schedule.sessions[idx].booked += pSize
    await transaction.collection(COL.schedules).doc(schedule._id).update({
      data: { sessions: schedule.sessions }
    })

    const needReview = !!p.needReview
    const reservation = {
      projectId, scheduleId: schedule._id, sessionId,
      openid: OPENID, name: name.trim(), phone, partySize: pSize, note: note || '',
      date, sessionStart: session.start, sessionEnd: session.end,
      status: needReview ? 'pending' : 'confirmed',
      review: needReview ? 'pending' : 'none',
      createdAt: Date.now(), reviewedAt: null
    }
    const add = await transaction.collection(COL.reservations).add({ data: reservation })
    await transaction.commit()

    await sendSubscribe({
      openid: OPENID,
      templateId: needReview ? TPL.reserveReview : TPL.reserveSuccess,
      data: {}, page: 'pages/mine/mine'
    })
    return ok({ id: add._id, status: reservation.status, review: reservation.review })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '预约失败')
  }
}
