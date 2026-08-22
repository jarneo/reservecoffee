// remindReservation — 开场前提醒 + 结束提醒（由定时触发器每 15 分钟调用）
// · 开场前提醒（reminder）：status='confirmed'、未提醒过、开场前 0~60 分钟内
// · 结束提醒（reminderEnd）：场次已结束（now>=endTime）、未提醒过，仅预订人
const { db, _, COL, TPL, ok, wxCtx, ymd, monthDay, sendSubscribe } = require('./lib')

exports.main = async () => {
  const now = Date.now()

  const res = await db.collection(COL.reservations)
    .where({
      status: 'confirmed',
      reminded: _.neq(true),
      ended: _.neq(true)
    })
    .limit(100)
    .get()
    .catch(() => ({ data: [] }))

  const items = res.data || []
  let sentStart = 0
  let sentEnd = 0
  let skipped = 0

  for (const r of items) {
    const [y, m, d] = String(r.date).split('-').map(Number)
    if (!y || !m || !d) { skipped++; continue }
    const [sh, sm] = String(r.sessionStart || '00:00').split(':').map(Number)
    const start = new Date(y, m - 1, d, sh, sm).getTime()
    const [eh, em] = String(r.sessionEnd || '23:59').split(':').map(Number)
    const endTime = new Date(y, m - 1, d, eh, em).getTime()

    // 读取项目名（结束提醒与开场提醒的 thing10 都需要）
    const pRes = await db.collection(COL.projects).doc(r.projectId).get().catch(() => ({ data: null }))
    const pName = (pRes.data && pRes.data.name) || '预约'

    // 结束提醒：场次已结束（now>=endTime）且未发过 → reminderEnd（仅顾客）
    if (now >= endTime) {
      if (!TPL.reminderEnd || TPL.reminderEnd.indexOf('TPL_ID_') === 0) { skipped++; continue }
      await sendSubscribe({
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
      await db.collection(COL.reservations).doc(r._id).update({ data: { ended: true } }).catch(() => {})
      sentEnd++
      continue
    }

    // 开场前提醒：未开始 且 开场前 ≤ 60 分钟 → reminder（仅顾客）
    const diff = start - now
    if (diff <= 0 || diff > 60 * 60 * 1000) { skipped++; continue }
    if (!TPL.reminder || TPL.reminder.indexOf('TPL_ID_') === 0) { skipped++; continue }

    await sendSubscribe({
      openid: r.openid,
      templateId: TPL.reminder,
      data: {
        thing10: { value: pName },
        time1: { value: `${r.date} ${r.sessionStart}` },
        thing5: { value: '预约时间很近了，记得还有一个预约，路上注意安全哦。' }
      },
      page: 'pages/mine/mine'
    })
    await db.collection(COL.reservations).doc(r._id).update({ data: { reminded: true } }).catch(() => {})
    sentStart++
  }

  return ok({ checked: items.length, sentStart, sentEnd, skipped })
}
