// createReservation — 提交预约（事务防超卖 + 双轴状态）
const { db, _, COL, TPL, ok, fail, wxCtx, addDays, monthDay, getStoreName, sendSubscribe, notifyAdmins, loadSubscribeSwitch, subOn } = require('./lib')
const { sendTemplateSms, loadConfig } = require('./sms')

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
  // ⚠️ SCF 运行时为 UTC，必须用 Date.UTC 显式构造北京时间，否则截止判定偏移 +8h
  const start = new Date(Date.UTC(y, mo - 1, d, Math.floor(mins / 60), mins % 60) - 8 * 3600 * 1000)
  const offset = Number(cutoff.minutes) * 60000
  const deadline = cutoff.mode === 'before'
    ? new Date(start.getTime() - offset)
    : new Date(start.getTime() + offset)
  return Date.now() >= deadline.getTime()
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('无法识别用户身份')

  // 黑名单拦截（事务前，避免无效占额）
  try {
    const u = await db.collection(COL.users).doc(OPENID).get().catch(() => null)
    if (u && u.data && u.data.isBlacklisted) {
      return fail('该账号已被加入黑名单，暂无法预约')
    }
  } catch (e) { /* 查询失败不阻断主流程 */ }

  const { projectId, date, sessionId, name, phone, partySize, note, wechat, gender, age } = event
  if (!projectId || !date || !sessionId) return fail('参数缺失')
  // 手机号非必填：仅当填写时校验格式
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) return fail('请填写正确的手机号')
  if (!name || !name.trim()) return fail('请填写称呼')
  const pSize = Number(partySize) || 1
  if (pSize < 1) return fail('预约人数无效')

  // 读项目配置
  const pRes = await db.collection(COL.projects).doc(projectId).get().catch(() => ({ data: null }))
  const p = pRes.data
  if (!p || !p.published) return fail('项目不存在或未发布')
  const subCfg = await loadSubscribeSwitch(db)
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

    // 短信全局配置（成功短信延迟计划）；失败不阻断主流程
    let smsSw = {}
    try {
      const swRes = await db.collection('config').doc('smsnotify').get().catch(() => ({ data: null }))
      smsSw = swRes && swRes.data ? swRes.data : {}
    } catch (e) { /* ignore */ }
    // 仅在「免审」路径于此处发送成功短信；待审路径由 reviewReservation 在审批通过时发送
    const successEnabled = !needReview && p.smsEnabled && smsSw.success !== false
    const successDelay = successEnabled ? (typeof smsSw.successDelay === 'number' ? smsSw.successDelay : 0) : -1

    const reservation = {
      projectId, scheduleId: schedule._id, sessionId,
      openid: OPENID, name: name.trim(), phone: phone || '', partySize: pSize,
      note: note || '', wechat: wechat || '', gender: gender || '', age: age || '',
      date, sessionStart: session.start, sessionEnd: session.end,
      status: needReview ? 'pending' : 'confirmed',
      review: needReview ? 'pending' : 'none',
      createdAt: Date.now(), reviewedAt: null,
      // 成功短信发送计划：-1 不发送；0 立即（提交后由下方发送）；>0 延迟（到点由 remindReservation 发送）
      // 延迟(>0)才标记为未发送并写入 smsSuccessAt，其余(立即/不发送)直接标记已发送，避免 remindReservation 重复补发
      smsSuccessSent: successDelay > 0 ? false : true,
      smsSuccessAt: successDelay > 0 ? Date.now() + successDelay * 60000 : 0
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
    if (!needReview && p.subscribeNotify !== false && subOn(subCfg, 'reserveSuccess')) await sendSubscribe({
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

    // B 线 · 给所有管理员（owner + manager）；结果记录到 adminNotify 供排查
    let adminNotify = null
    if (p.subscribeNotify !== false) {
      if (needReview) {
        // 待审：字段须对齐微信后台「待审核提醒」模板（thing1 门店名称 / time2 计划就餐时间 / number3 用餐人数）
        if (subOn(subCfg, 'adminReview')) {
          adminNotify = await notifyAdmins(db, {
            templateId: TPL.adminReview,
            data: {
              thing1: { value: p.name },
              time2: { value: `${date} ${session.start}` },
              number3: { value: pSize }
            },
            page: 'pages/admin/review/review'
          })
        }
      } else {
        // 免审：项目 · 预订人 · 日期场次（thing3 上限 20 字，仅放日期场次 dt，不拼人数）
        if (subOn(subCfg, 'adminNew')) {
          adminNotify = await notifyAdmins(db, {
            templateId: TPL.adminNew,
            data: {
              thing1: { value: p.name },
              thing12: { value: name.trim() },
              thing3: { value: dt }
            },
            page: 'pages/admin/hub/hub'
          }).catch(e => { console.warn('[createReservation] notifyAdmins failed:', e && e.message); return [{ ok: false, err: e && e.message }] })
        }
      }
    }

    // 短信推送（成功短信，仅免审路径在此发送；待审路径由 reviewReservation 在审批通过时发送）
    // 全局开关 + 项目开关 双重控制，仅发预订人；延迟(successDelay>0)由 remindReservation 定时发送
    // successDelay===0 时 reservation.smsSuccessSent 在创建时已置 true，此处执行发送并校正真实结果
    let smsResult = null
    if (!needReview && successDelay === 0) {
      try {
        const smsApp = await loadConfig(db)
        const tid = smsApp && smsApp.templates && smsApp.templates.success
        if (tid) smsResult = await sendTemplateSms({ db, phone, templateId: tid })
      } catch (e) { console.warn('[createReservation] sms failed (ignored):', e.message) }
      // 平台级拒收（单号日上限/模板未审批等）不抛异常但 Code!=Ok，sendTemplateSms 已返回 ok:false；
      // 校正标记，避免假成功误导排查
      if (smsResult && !smsResult.ok) {
        try {
          await db.collection(COL.reservations).doc(add._id).update({
            data: { smsSuccessSent: false, smsResult }
          })
        } catch (e) { console.warn('[createReservation] sms result update failed:', e.message) }
      }
    }

    // 诊断：把管理侧订阅发送结果落库，便于排查「收不到待审核推送」（不阻断主流程）
    if (add && add._id && adminNotify) {
      try { await db.collection(COL.reservations).doc(add._id).update({ data: { adminNotify } }) } catch (e) {}
    }

    return ok({ id: add._id, status: reservation.status, review: reservation.review })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '预约失败')
  }
}
