// remindReservation — 定时任务（每 15 分钟；调度须由微信开发者工具「上传触发器」注册的 TCB_API 调度，
// 用 MCP/SCF 建的原生定时器拿不到微信 token，必然 -501001）
//
// 本函数承担四件事：
//  ① 成功短信延迟补发：smsSuccessAt 到点且未发过 → success 模板（仅预订人）
//  ② 提前一天提醒：每天 dayBeforeAt（默认 17:30，北京时间）给「次日有预约」的顾客推送
//     微信 dayBefore 模板 + 短信 dayBefore 模板（2729722）；同一用户次日多笔只发最早一场
//  ③ 取消短信延迟补发：smsCancelAt 到点 → 发送前复校该预约此刻仍为 cancelled 才发（cancel 模板 2729679）
//  ④ 开场前提醒（reminder）+ 结束提醒（reminderEnd），仅预订人
//
// 短信总控：全局开关(config.smsnotify) + 项目开关(projects.smsEnabled) 双重控制；
// 【微信优先降级】skipSmsIfWxOk=true 时，若同一事件的微信订阅消息已送达（ok:true），该事件不再补发短信。
const { db, _, COL, TPL, ok, sendSubscribe, subOn, shouldSkipSms, getStoreName } = require('./lib')
const { sendTemplateSms, loadConfig } = require('./sms')

const DAY_BEFORE_DEFAULT_AT = '17:30'
const DAY_BEFORE_TIP = '明天有预约哦，别忘记了。'
// 前一天提醒的发送时间窗（分钟）：仅在 [dayBeforeAt, dayBeforeAt + 本值] 内触发。
// 目的：① 避免定时任务长时间故障/停用后，恢复当天在深夜补发（如 23:00 推送「明天有预约」很打扰）；
//      ② 避免「部署当天已过 17:30」时立刻补发一批。窗口内新建的预约仍会在下一轮（≤15 分钟）被覆盖。
// 当天错过窗口即不再补发（顾客在下单时已收到「预约成功」卡片，不重复打扰）。
const DAY_BEFORE_WINDOW_MIN = 180

// 结束提醒 / 过期短信的发送时间窗（分钟）：仅在 [expiredFireAt, expiredFireAt + 本值] 内**发送**。
// 超窗只落 `ended: true` 标记（幂等、不再重试），并记 `reminderEndSkipped: 'too-late'`。
// 目的：定时任务长时间停用后恢复、或历史积压被批量补扫时，不在深夜给顾客补发
//      「预约已完成，感谢您的到来」（与 DAY_BEFORE_WINDOW_MIN 同一设计取向）。
const END_SEND_WINDOW_MIN = 120

// 北京时间读数：SCF 运行时为 UTC，整体 +8h 后用 UTC getter 读即得北京时间（勿用本地 getter）
function bjParts(ts) {
  const t = new Date(ts + 8 * 3600 * 1000)
  return {
    date: `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`,
    min: t.getUTCHours() * 60 + t.getUTCMinutes()
  }
}
// 'YYYY-MM-DD' + n 天
function plusDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}
// 'HH:mm' → 当日分钟数（非法返回 null）
function hhmmMin(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
// 场次时长（分钟）= 结束 - 开始
function durationMin(start, end) {
  const a = /^(\d{1,2}):(\d{2})$/.exec(String(start || ''))
  const b = /^(\d{1,2}):(\d{2})$/.exec(String(end || ''))
  if (!a || !b) return 0
  const s = Number(a[1]) * 60 + Number(a[2])
  const e = Number(b[1]) * 60 + Number(b[2])
  return e > s ? e - s : 0
}

// 前一天提醒 · 微信模板「入场时间通知」（模板编号 22555，类目：餐厅排队）字段键
// ⚠️ 已与 MP 后台「详细内容」逐字核对（2026-09-11）：
//      地点 {{thing2.DATA}} / 入场时间 {{time1.DATA}} / 入场时长 {{thing3.DATA}} / 温馨提醒 {{thing4.DATA}}
//    - thing 类型值上限 20 字；time 类型需合法日期时间（yyyy-mm-dd hh:mm）。
//    - 键名/序号错 → 47003 data.xxx.value invalid 且失败被静默吞；改后台模板后必须同步这里。
const DAY_BEFORE_KEY = { place: 'thing2', time: 'time1', duration: 'thing3', tip: 'thing4' }
function dayBeforeData(o) {
  return {
    [DAY_BEFORE_KEY.place]: { value: o.store },
    [DAY_BEFORE_KEY.time]: { value: `${o.date} ${o.sessionStart}` },
    [DAY_BEFORE_KEY.duration]: { value: `${o.minutes}分钟` },
    [DAY_BEFORE_KEY.tip]: { value: DAY_BEFORE_TIP }
  }
}

exports.main = async () => {
  const now = Date.now()
  const bj = bjParts(now)

  // ===== 全局配置（循环前各读一次） =====
  let smsSw = {}
  let tpls = {}
  let subCfg = {}
  try {
    const swRes = await db.collection('config').doc('smsnotify').get().catch(() => ({ data: null }))
    smsSw = (swRes && swRes.data) || {}
    const app = await loadConfig(db)
    tpls = (app && app.templates) || {}
  } catch (e) { /* 短信配置缺失时不影响订阅提醒 */ }
  try {
    const subRes = await db.collection('config').doc('subscribe').get().catch(() => ({ data: null }))
    subCfg = (subRes && subRes.data) || {}
  } catch (e) { /* 订阅开关缺失不影响短信 */ }

  const approachingWhen = smsSw.approachingWhen === 'after' ? 'after' : 'before'   // 默认 开始前
  const approachingOffset = typeof smsSw.approachingOffset === 'number' ? smsSw.approachingOffset : 60
  const expiredWhen = smsSw.expiredWhen === 'before' ? 'before' : 'after'          // 默认 结束后（与管理台一致）
  const expiredOffset = typeof smsSw.expiredOffset === 'number' ? smsSw.expiredOffset : 5
  const smsSuccessOn = smsSw.success !== false
  const smsCancelOn = smsSw.cancel !== false
  const smsDayBeforeOn = smsSw.dayBefore !== false

  // 项目信息缓存（一次执行内复用，避免逐条查库）
  const projCache = new Map()
  const projectOf = async (pid) => {
    if (!pid) return {}
    if (projCache.has(pid)) return projCache.get(pid)
    const r = await db.collection(COL.projects).doc(pid).get().catch(() => ({ data: null }))
    const p = (r && r.data) || {}
    projCache.set(pid, p)
    return p
  }

  let sentSuccess = 0
  let sentStart = 0
  let sentEnd = 0
  let sentDayBefore = 0
  let sentDayBeforeSms = 0
  let sentCancel = 0
  let skipped = 0

  // ===== ① 成功短信延迟补发（smsSuccessAt 到点） =====
  try {
    const sRes = await db.collection(COL.reservations)
      .where({ smsSuccessSent: _.neq(true), smsSuccessAt: _.lte(now), status: _.neq('cancelled') })
      .limit(100).get().catch(() => ({ data: [] }))
    for (const r of (sRes.data || [])) {
      const p = await projectOf(r.projectId)
      const patch = { smsSuccessSent: true }
      if (smsSuccessOn && p.smsEnabled && tpls.success && r.phone) {
        // 微信优先降级：创建/审核时「预约成功」订阅卡片已送达 → 不再补发成功短信
        if (shouldSkipSms(smsSw, { ok: r.wxSuccessOk === true, skipped: false })) {
          patch.smsResult = { skipped: true, reason: 'wx subscribe delivered (skipSmsIfWxOk)' }
        } else {
          try {
            const res = await sendTemplateSms({ db, phone: r.phone, templateId: tpls.success })
            patch.smsResult = res
            if (res && res.ok) sentSuccess++
          } catch (e) { console.warn('[remindReservation] success sms failed (ignored):', e.message) }
        }
      }
      // 无论成功与否均打标，避免同一号码每 15 分钟无限重试（平台级拒收需人工排查）
      await db.collection(COL.reservations).doc(r._id).update({ data: patch }).catch(() => {})
    }
  } catch (e) { console.warn('[remindReservation] success pass failed (ignored):', e.message) }

  // ===== ② 提前一天提醒（每天 dayBeforeAt，默认 17:30） =====
  try {
    const fireMin = hhmmMin(smsSw.dayBeforeAt)
    const atMin = fireMin == null ? hhmmMin(DAY_BEFORE_DEFAULT_AT) : fireMin
    const winMin = typeof smsSw.dayBeforeWindow === 'number' && smsSw.dayBeforeWindow >= 0 ? smsSw.dayBeforeWindow : DAY_BEFORE_WINDOW_MIN
    if (bj.min >= atMin && bj.min <= atMin + winMin) {
      const tomorrow = plusDays(bj.date, 1)
      const dRes = await db.collection(COL.reservations)
        .where({ date: tomorrow, status: 'confirmed', dayBeforeNotified: _.neq(true) })
        .limit(100).get().catch(() => ({ data: [] }))
      const rows = (dRes.data || []).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')))
      // 同一用户次日多笔 → 只发最早一场（sessionStart 升序；相同则按创建时间）
      const byOpenid = new Map()
      for (const r of rows) {
        const cur = byOpenid.get(r.openid)
        const earlier = !cur
          || String(r.sessionStart || '') < String(cur.sessionStart || '')
          || (String(r.sessionStart || '') === String(cur.sessionStart || '') && (r.createdAt || 0) < (cur.createdAt || 0))
        if (earlier) byOpenid.set(r.openid, r)
      }
      const picked = new Set(Array.from(byOpenid.values()).map(r => r._id))
      const store = await getStoreName(db)
      // 便于 CLS 排查：本轮目标（次日）、总笔数、去重后待发笔数
      console.log('[dayBefore] target=', tomorrow, 'rows=', rows.length, 'picked=', picked.size, 'at=', bj.min)

      for (const r of rows) {
        const patch = { dayBeforeNotified: true }
        if (picked.has(r._id)) {
          const p = await projectOf(r.projectId)
          // —— 微信订阅（顾客）——
          let notify = null
          if (TPL.dayBefore && TPL.dayBefore.indexOf('TPL_ID_') !== 0 && subOn(subCfg, 'dayBefore')) {
            notify = await sendSubscribe({
              openid: r.openid,
              templateId: TPL.dayBefore,
              data: dayBeforeData({
                date: r.date,
                sessionStart: r.sessionStart,
                minutes: durationMin(r.sessionStart, r.sessionEnd),
                store
              }),
              page: 'pages/mine/mine'
            })
          }
          // —— 短信兜底（微信优先降级）——
          let smsRes = null
          if (smsDayBeforeOn && p.smsEnabled && tpls.dayBefore && r.phone) {
            if (shouldSkipSms(smsSw, notify)) {
              smsRes = { skipped: true, reason: 'wx subscribe delivered (skipSmsIfWxOk)' }
            } else {
              try {
                smsRes = await sendTemplateSms({ db, phone: r.phone, templateId: tpls.dayBefore })
                if (smsRes && smsRes.ok) sentDayBeforeSms++
              } catch (e) { console.warn('[remindReservation] dayBefore sms failed (ignored):', e.message) }
            }
          }
          patch.dayBeforeNotify = notify
          patch.dayBeforeSms = smsRes
          sentDayBefore++
        } else {
          // 同一用户同日已由更早一场覆盖，本笔不再重复打扰
          patch.dayBeforeSkipped = 'dup-openid'
        }
        await db.collection(COL.reservations).doc(r._id).update({ data: patch }).catch(() => {})
      }
    }
  } catch (e) { console.warn('[remindReservation] dayBefore pass failed (ignored):', e.message) }

  // ===== ③ 取消短信延迟补发（smsCancelAt 到点；发前复校仍为 cancelled） =====
  try {
    const cRes = await db.collection(COL.reservations)
      .where({ smsCancelSent: _.neq(true), smsCancelAt: _.lte(now) })
      .limit(100).get().catch(() => ({ data: [] }))
    for (const r of (cRes.data || [])) {
      const patch = { smsCancelSent: true }
      if (r.status !== 'cancelled') {
        // 状态复校：已被恢复/重建，不再发「已取消」短信
        patch.smsCancelResult = { skipped: true, reason: 'no longer cancelled' }
      } else if (!smsCancelOn || !r.phone) {
        patch.smsCancelResult = { skipped: true, reason: smsCancelOn ? 'no phone' : 'global switch off' }
      } else {
        const p = await projectOf(r.projectId)
        if (!p.smsEnabled || !tpls.cancel) {
          patch.smsCancelResult = { skipped: true, reason: p.smsEnabled ? 'no cancel template' : 'project sms off' }
        } else {
          try {
            const res = await sendTemplateSms({ db, phone: r.phone, templateId: tpls.cancel })
            patch.smsCancelResult = res
            if (res && res.ok) sentCancel++
          } catch (e) { console.warn('[remindReservation] cancel sms failed (ignored):', e.message) }
        }
      }
      await db.collection(COL.reservations).doc(r._id).update({ data: patch }).catch(() => {})
    }
  } catch (e) { console.warn('[remindReservation] cancel pass failed (ignored):', e.message) }

  // ===== ④ 临近 / 过期 提醒（开场前/后、结束前/后） =====
  // ⚠️ 只按 ended 过滤，**不能**再带上 `reminded: _.neq(true)`：
  //    绝大多数预约都会先收到「开场前提醒」(reminded=true)，若用它做查询条件，
  //    这些预约从此不再进入循环 → 下面的 ended 分支永远走不到
  //    → 结束提醒/过期短信不发、`ended` 也不打（顾客端就一直显示「预约成功」）。
  //    已经提醒过的由循环内的 `!r.reminded` 守卫避免重复发送。
  const res = await db.collection(COL.reservations)
    .where({ status: 'confirmed', ended: _.neq(true) })
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

    const p = await projectOf(r.projectId)
    const pName = p.name || '预约'
    const smsEnabled = !!p.smsEnabled

    // 触发时刻：根据「开始前/后 + 偏移」与「结束前/后 + 偏移」计算
    const approachFireAt = approachingWhen === 'after' ? start + approachingOffset * 60000 : start - approachingOffset * 60000
    const expiredFireAt = expiredWhen === 'after' ? endTime + expiredOffset * 60000 : endTime - expiredOffset * 60000

    // 过期提醒优先：到达 expiredFireAt 且未发过 → reminderEnd（仅顾客）+ 过期短信
    if (now >= expiredFireAt) {
      const patch = { ended: true }
      if (now - expiredFireAt > END_SEND_WINDOW_MIN * 60000) {
        // 超出发送时间窗（任务长时间停用后恢复 / 历史积压）→ 只打标记，不再深夜打扰
        patch.reminderEndSkipped = 'too-late'
      } else {
        let reminderEndNotify = null
        if (TPL.reminderEnd && TPL.reminderEnd.indexOf('TPL_ID_') !== 0 && subOn(subCfg, 'reminderEnd')) {
          reminderEndNotify = await sendSubscribe({
            openid: r.openid,
            templateId: TPL.reminderEnd,
            data: {
              thing10: { value: pName },
              time12: { value: `${r.date} ${r.sessionStart}` },
              time14: { value: `${r.date} ${r.sessionEnd}` },
              // ⚠️ 同上：thing 关键字 ≤ 20 字（原 27 字，授权后必踩 47003）
              thing9: { value: '预约已完成，感谢您的到来，期待下次相见' }
            },
            page: 'pages/mine/mine'
          })
        }
        if (smsSw.expired !== false && smsEnabled && tpls.expired && !shouldSkipSms(smsSw, reminderEndNotify)) {
          try { await sendTemplateSms({ db, phone: r.phone, templateId: tpls.expired }) }
          catch (e) { console.warn('[remindReservation] expired sms failed (ignored):', e.message) }
        }
        patch.reminderEndNotify = reminderEndNotify
      }
      // 无论发没发都打 ended（避免无限重试）；结果落库便于排查 43101 / 超窗跳过
      await db.collection(COL.reservations).doc(r._id).update({ data: patch }).catch(() => {})
      sentEnd++
      continue
    }

    // 临近提醒：到达 approachFireAt 且**未发过** → reminder（仅顾客）+ 临近短信
    if (!r.reminded && now >= approachFireAt) {
      let reminderNotify = null
      if (TPL.reminder && TPL.reminder.indexOf('TPL_ID_') !== 0 && subOn(subCfg, 'reminder')) {
        reminderNotify = await sendSubscribe({
          openid: r.openid,
          templateId: TPL.reminder,
          data: {
            thing10: { value: pName },
            time1: { value: `${r.date} ${r.sessionStart}` },
            // ⚠️ thing 关键字上限 20 字，超长直接 47003 data.thingN.value invalid（失败被静默吞）
            thing5: { value: '预约快到了，路上注意安全哦' }
          },
          page: 'pages/mine/mine'
        })
      }
      if (smsSw.approaching !== false && smsEnabled && tpls.approaching && !shouldSkipSms(smsSw, reminderNotify)) {
        try { await sendTemplateSms({ db, phone: r.phone, templateId: tpls.approaching }) }
        catch (e) { console.warn('[remindReservation] approaching sms failed (ignored):', e.message) }
      }
      // 照常打 reminded（避免无限重试）；结果落库便于排查 43101
      await db.collection(COL.reservations).doc(r._id).update({ data: { reminded: true, reminderNotify } }).catch(() => {})
      sentStart++
    }
  }

  return ok({ checked: items.length, sentSuccess, sentDayBefore, sentDayBeforeSms, sentCancel, sentStart, sentEnd, skipped })
}
