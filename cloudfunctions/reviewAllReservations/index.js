// reviewAllReservations — 批量审核通过所有待审核预约（owner/manager）
// 与 reviewReservation 单条逻辑等价：逐条事务改状态 + 成功短信 + 预约成功/审核结果订阅，并汇总结果。
// ⚠️ 单条审核逻辑与 reviewReservation/index.js 保持同步；后者改动时本函数须同步。
// ⚠️ 黑名单保护：批量「全部通过」不得放行黑名单用户（其待审预约可能提交于加黑之前），
//    一律跳过并保持 pending，由管理员在审核页看到红标后逐条人工决定。
const { db, _, COL, TPL, ok, fail, wxCtx, getRole, monthDay, getStoreName, sendSubscribe, notifyAdmins, loadSubscribeSwitch, subOn, shouldSkipSms } = require('./lib')
const { sendTemplateSms, loadConfig } = require('./sms')

// 拉全部黑名单 openid 集合（分页，规避单批上限）
async function loadBlacklist() {
  const set = new Set()
  let skip = 0
  for (let i = 0; i < 20; i++) {
    const res = await db.collection(COL.users)
      .where({ isBlacklisted: true })
      .skip(skip).limit(100)
      .get()
      .catch(() => ({ data: [] }))
    const rows = res.data || []
    rows.forEach(u => set.add(u._id))
    if (rows.length < 100) break
    skip += 100
  }
  return set
}

// 处理单条待审核预约（与 reviewReservation 内部逻辑一致）
// blSet: 黑名单 openid 集合；命中且为通过操作时跳过
async function processOne(reservationId, decision, blSet) {
  const rRes = await db.collection(COL.reservations).doc(reservationId).get().catch(() => ({ data: null }))
  const r = rRes.data
  if (!r) return { ok: false, reservationId, reason: 'not found' }
  if (r.review !== 'pending') return { ok: false, reservationId, reason: 'not pending' }
  // 黑名单保护：仅在「通过」方向拦截；拒绝方向仍需放行（管理员本就要取消其预约）
  if (decision === 'approve' && blSet && blSet.size && r.openid && blSet.has(r.openid)) {
    return { ok: false, reservationId, reason: 'blacklisted' }
  }

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
    const subCfg = await loadSubscribeSwitch(db)

    // 审核通过 → 推送「预约成功」给顾客（小程序订阅）
    // ⚠️ 先发订阅再发短信：其返回值决定「微信优先降级」是否跳过成功短信
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

    // 审核通过 → 短信「已为您留座」（全局开关 + 项目开关 双重控制，仅预订人）
    // 【微信优先降级】skipSmsIfWxOk 开启且订阅卡片已送达 → 不再发成功短信
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
              await db.collection(COL.reservations).doc(reservationId).update({
                data: { smsSuccessSent: true, smsResult: { skipped: true, reason: 'wx subscribe delivered (skipSmsIfWxOk)' } }
              }).catch(() => {})
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
      } catch (e) { console.warn('[reviewAll] sms failed (ignored):', e.message) }
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
    // ⚠️ 与 reviewReservation/index.js 的分支保持同步（本文件顶部已有同源要求）。
    const adminNotifyReview = { skipped: true, decision, reason: 'admin push disabled on review' }
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

  // 黑名单集合：批量通过时跳过（仅 approve 方向）
  const blSet = decision === 'approve' ? await loadBlacklist() : new Set()

  let approved = 0, skipped = 0, failed = 0, blacklisted = 0
  const errors = []
  for (const r of pending) {
    const out = await processOne(r._id, decision, blSet)
    if (out.ok) approved++
    else if (out.reason === 'blacklisted') blacklisted++
    else if (out.reason === 'not pending') skipped++
    else { failed++; errors.push({ id: r._id, reason: out.reason }) }
  }
  return ok({ total: pending.length, approved, skipped, failed, blacklisted, errors })
}
