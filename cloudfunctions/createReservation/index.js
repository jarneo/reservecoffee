// createReservation — 提交预约（事务防超卖 + 双轴状态）
const { db, _, COL, TPL, ok, fail, wxCtx, addDays, monthDay, getStoreName, sendSubscribe, notifyAdmins } = require('./lib')
const { sendReservationSms } = require('./sms')

// 场次是否已过预约截止（与顾客端 isSessionExpired 同源规则）
// cutoff: { mode:'before'|'after', minutes }；未配置 / 非法 则不限制
function parseHm(t) {
  const a = String(t || '').split(':').map(Number)
  return (isNaN(a[0]) ? 0 : a[0]) * 60 + (isNaN(a[1]) ? 0 : a[1])
}
function sessionExpired(dateStr, startStr, cutoff) {
  if (!cutoff || (cutoff.mode !== 'before' && cutoff.mode !== 'after') || !(Number(cutoff.minutes) > 0)) return false
  const [y, mo, d] = String(dateStr || '').split('-').map(Number)
  if (!y || !mo || !d) return false
  const mins = parseHm(startStr)
  const start = new Date(y, mo - 1, d, Math.floor(mins / 60), mins % 60)
  const offset = Number(cutoff.minutes) * 60000
  const deadline = cutoff.mode === 'before'
    ? new Date(start.getTime() - offset)
    : new Date(start.getTime() + offset)
  return Date.now() >= deadline.getTime()
}

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

  const maxParty = Number(p.maxParty) || 2
  if (pSize > maxParty) return fail('单次预约人数不能超过 ' + maxParty + ' 人')

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
    if (schedule.closed) { await transaction.rollback(); return fail('该日期已暂停预约') }

    const idx = (schedule.sessions || []).findIndex(s => s.id === sessionId)
    if (idx < 0) { await transaction.rollback(); return fail('场次不存在') }
    const session = schedule.sessions[idx]
    if (session.paused) { await transaction.rollback(); return fail('该场次已暂停预约') }
    if (sessionExpired(date, session.start, p.cutoff)) { await transaction.rollback(); return fail('该场次已过期，无法预约') }
    if (session.capacity - session.booked < pSize) { await transaction.rollback(); return fail('该场次名额不足') }

    // 每日上限（按 openid+project+date 的有效预约）。是否允许同场次重复预约，仅由 dailyLimit 控制；
    // 不再限制「同一场次只能预约一次」（历史逻辑会误拦老顾客的重复预约）。
    const daily = await transaction.collection(COL.reservations).where({
      openid: OPENID, projectId, date,
      status: _.in(['pending', 'confirmed']), review: _.neq('rejected')
    }).count()
    if (daily.total >= (p.dailyLimit || 1)) {
      await transaction.rollback(); return fail('今日该项目的预约次数已达上限')
    }

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

    // 同步顾客资料到 users 集合，使下次预约自动带出（失败不阻断主流程）
    try {
      const up = { name: name.trim(), phone, updatedAt: Date.now() }
      const ex = await db.collection(COL.users).doc(OPENID).get().catch(() => null)
      if (ex && ex.data) await db.collection(COL.users).doc(OPENID).update({ data: up })
      else await db.collection(COL.users).doc(OPENID).set({ data: { openid: OPENID, ...up } })
    } catch (e) {
      console.warn('[createReservation] save profile failed (ignored):', e.message)
    }

    // 店铺名（以店铺名义）；友好日期场次+几人位，供文案复用
    const storeName = await getStoreName(db)
    const dt = `${monthDay(date)} ${session.start}-${session.end}`
    const seats = `${pSize}人位`

    // A 线 · 给预订人（仅免审立即推送「预约成功」；待审不发，改由管理员审核通过后再推送）
    if (!needReview && p.subscribeNotify !== false) await sendSubscribe({
      openid: OPENID,
      templateId: TPL.reserveSuccess,
      data: {
        thing10: { value: p.name },
        time12: { value: `${date} ${session.start}` },
        thing6: { value: seats },
        thing9: { value: '已为您留座，请准时赴约，期待与您相见～' }
      },
      page: 'pages/mine/mine'
    })

    // B 线 · 给所有管理员（owner + manager）
    if (p.subscribeNotify !== false) {
      if (needReview) {
        // 待审：仅项目 · 预约时间 · 人数（便于登录审批，不带手机号/预订人详情）
        await notifyAdmins(db, {
          templateId: TPL.adminReview,
          data: {
            thing5: { value: p.name },
            thing1: { value: name.trim() },
            time4: { value: `${date} ${session.start}` },
            phone_number2: { value: phone }
          },
          page: 'pages/admin/review/review'
        })
      } else {
        // 免审：项目 · 预订人 · 日期场次（thing3 上限 20 字，仅放日期场次 dt，不拼人数）
        await notifyAdmins(db, {
          templateId: TPL.adminNew,
          data: {
            thing1: { value: p.name },
            thing12: { value: name.trim() },
            thing3: { value: dt }
          },
          page: 'pages/admin/hub/hub'
        }).catch(e => console.warn('[createReservation] notifyAdmins adminReview failed (ignored):', e && e.message))
      }
    }

    // 短信推送（每项目独立开关）：单条留座，仅发预订人，压成一条 ≤70 字
    if (p.smsEnabled) {
      sendReservationSms({
        db, phone, name: name.trim(),
        date: monthDay(date),
        time: `${session.start}-${session.end}`,
        seats
      }).catch(() => {})
    }

    return ok({ id: add._id, status: reservation.status, review: reservation.review })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '预约失败')
  }
}
