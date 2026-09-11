// remindReservation — 成功短信延迟补发 + 开场前提醒 + 结束提醒（由定时触发器每 15 分钟调用）
// · 成功短信：smsSuccessAt 到点且未发送过 → 发送 success 模板（仅预订人）
// · 开场前/后提醒（reminder）：status='confirmed'、未提醒过、到达 approachFireAt
// · 结束前/后提醒（reminderEnd）：到达 expiredFireAt 且未发过，仅预订人
// 短信：全局开关(smsnotify) + 项目开关(smsEnabled) 双重控制；三个业务模板均为无参数模板
const { db, _, COL, TPL, ok, sendSubscribe, subOn } = require('./lib')
const { sendTemplateSms, loadConfig } = require('./sms')

exports.main = async () => {
  const now = Date.now()

  // 全局短信开关 + 模板 ID（循环前读取一次）
  let smsSw = {}
  let tpls = {}
  try {
    const swRes = await db.collection('config').doc('smsnotify').get().catch(() => ({ data: null }))
    smsSw = swRes && swRes.data ? swRes.data : {}
    const app = await loadConfig(db)
    tpls = app && app.templates ? app.templates : {}
  } catch (e) { /* 短信配置缺失时不影响订阅提醒 */ }

  // 订阅模板开关（循环前读取一次）
  let subCfg = {}
  try {
    const subRes = await db.collection('config').doc('subscribe').get().catch(() => ({ data: null }))
    subCfg = subRes && subRes.data ? subRes.data : {}
  } catch (e) { /* 订阅开关缺失不影响短信 */ }

  // 时间配置（带默认值）
  const approachingWhen = smsSw.approachingWhen === 'after' ? 'after' : 'before'   // 默认 开始前
  const approachingOffset = typeof smsSw.approachingOffset === 'number' ? smsSw.approachingOffset : 60
  const expiredWhen = smsSw.expiredWhen === 'after' ? 'after' : 'before'           // 默认 结束后
  const expiredOffset = typeof smsSw.expiredOffset === 'number' ? smsSw.expiredOffset : 5
  const smsSuccessOn = smsSw.success !== false

  let sentSuccess = 0
  let sentStart = 0
  let sentEnd = 0
  let skipped = 0

  // ===== 成功短信延迟补发（smsSuccessAt 到点） =====
  try {
    const sRes = await db.collection(COL.reservations)
      .where({ smsSuccessSent: _.neq(true), smsSuccessAt: _.lte(now), status: _.neq('cancelled') })
      .limit(100).get().catch(() => ({ data: [] }))
    for (const r of (sRes.data || [])) {
      const pRes = await db.collection(COL.projects).doc(r.projectId).get().catch(() => ({ data: null }))
      const p = pRes.data || {}
      if (smsSuccessOn && p.smsEnabled && tpls.success && r.phone) {
        try {
          await sendTemplateSms({ db, phone: r.phone, templateId: tpls.success })
          sentSuccess++
        } catch (e) { console.warn('[remindReservation] success sms failed (ignored):', e.message) }
      }
      await db.collection(COL.reservations).doc(r._id).update({ data: { smsSuccessSent: true } }).catch(() => {})
    }
  } catch (e) { console.warn('[remindReservation] success pass failed (ignored):', e.message) }

  // ===== 临近 / 过期 提醒（开场前/后、结束前/后） =====
  const res = await db.collection(COL.reservations)
    .where({ status: 'confirmed', reminded: _.neq(true), ended: _.neq(true) })
    .limit(100).get().catch(() => ({ data: [] }))

  const items = res.data || []
  for (const r of items) {
    const [y, m, d] = String(r.date).split('-').map(Number)
    if (!y || !m || !d) { skipped++; continue }
    // ⚠️ SCF 运行时为 UTC，必须用 Date.UTC 显式构造北京时间，否则整体偏移 +8h（17:00 才触发）
    const [sh, sm] = String(r.sessionStart || '00:00').split(':').map(Number)
    const start = new Date(Date.UTC(y, m - 1, d, sh, sm) - 8 * 3600 * 1000).getTime()
    const [eh, em] = String(r.sessionEnd || '23:59').split(':').map(Number)
    const endTime = new Date(Date.UTC(y, m - 1, d, eh, em) - 8 * 3600 * 1000).getTime()

    const pRes = await db.collection(COL.projects).doc(r.projectId).get().catch(() => ({ data: null }))
    const p = pRes.data || {}
    const pName = p.name || '预约'
    const smsEnabled = !!p.smsEnabled

    // 触发时刻：根据「开始前/后 + 偏移」与「结束前/后 + 偏移」计算
    const approachFireAt = approachingWhen === 'after' ? start + approachingOffset * 60000 : start - approachingOffset * 60000
    const expiredFireAt = expiredWhen === 'after' ? endTime + expiredOffset * 60000 : endTime - expiredOffset * 60000

    // 过期提醒优先：到达 expiredFireAt 且未发过 → reminderEnd（仅顾客）+ 过期短信
    if (now >= expiredFireAt) {
      let reminderEndNotify = null
      if (TPL.reminderEnd && TPL.reminderEnd.indexOf('TPL_ID_') !== 0 && subOn(subCfg, 'reminderEnd')) {
        reminderEndNotify = await sendSubscribe({
          openid: r.openid,
          templateId: TPL.reminderEnd,
          data: {
            thing10: { value: pName },
            time12: { value: `${r.date} ${r.sessionStart}` },
            time14: { value: `${r.date} ${r.sessionEnd}` },
            thing9: { value: '您的预约已完成，感谢您的到来！如有疑问，可以联系店铺～' }
          },
          page: 'pages/mine/mine'
        })
      }
      if (smsSw.expired !== false && smsEnabled && tpls.expired) {
        try { await sendTemplateSms({ db, phone: r.phone, templateId: tpls.expired }) }
        catch (e) { console.warn('[remindReservation] expired sms failed (ignored):', e.message) }
      }
      // 照常打 ended（避免无限重试）；结果落库便于排查 43101
      await db.collection(COL.reservations).doc(r._id).update({ data: { ended: true, reminderEndNotify } }).catch(() => {})
      sentEnd++
      continue
    }

    // 临近提醒：到达 approachFireAt 且未发过 → reminder（仅顾客）+ 临近短信
    if (now >= approachFireAt) {
      let reminderNotify = null
      if (TPL.reminder && TPL.reminder.indexOf('TPL_ID_') !== 0 && subOn(subCfg, 'reminder')) {
        reminderNotify = await sendSubscribe({
          openid: r.openid,
          templateId: TPL.reminder,
          data: {
            thing10: { value: pName },
            time1: { value: `${r.date} ${r.sessionStart}` },
            thing5: { value: '预约时间很近了，记得还有一个预约，路上注意安全哦。' }
          },
          page: 'pages/mine/mine'
        })
      }
      if (smsSw.approaching !== false && smsEnabled && tpls.approaching) {
        try { await sendTemplateSms({ db, phone: r.phone, templateId: tpls.approaching }) }
        catch (e) { console.warn('[remindReservation] approaching sms failed (ignored):', e.message) }
      }
      // 照常打 reminded（避免无限重试）；结果落库便于排查 43101
      await db.collection(COL.reservations).doc(r._id).update({ data: { reminded: true, reminderNotify } }).catch(() => {})
      sentStart++
    }
  }

  return ok({ checked: items.length, sentSuccess, sentStart, sentEnd, skipped })
}
