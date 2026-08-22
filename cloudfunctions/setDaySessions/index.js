// setDaySessions — 设定某日场次（owner；同时将该日并入 openDays）
const { db, _, COL, ok, fail, wxCtx, getRole } = require('./lib')

function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可配置场次')

  const { projectId, date, sessions } = event
  if (!projectId || !date) return fail('缺少参数')
  if (!Array.isArray(sessions)) return fail('sessions 格式错误')

  // 校验场次
  const clean = sessions.map(s => ({
    id: s.id || uid(),
    start: String(s.start || ''),
    end: String(s.end || ''),
    capacity: Math.max(0, Number(s.capacity) || 0),
    booked: 0,
    paused: !!s.paused,
    desc: String(s.desc || '').slice(0, 100)
  })).filter(s => s.start && s.end)

  // ===== 防误删：若本次会移除「已有有效预约」的场次，则拒绝，避免预约成为孤儿 =====
  // 覆盖「清空当日场次」(sessions:[]) 与「套用模版」全量替换两类场景；
  // confirmAdd 仅追加（保留既有场次 id），不会触碰已有场次，不受影响。
  const existDoc = await db.collection(COL.schedules).where({ projectId, date }).get().catch(() => ({ data: [] }))
  const existSessions = (existDoc.data && existDoc.data[0] && existDoc.data[0].sessions) || []
  const incomingIds = new Set(clean.map(s => s.id))
  const removedIds = existSessions.filter(s => !incomingIds.has(s.id)).map(s => s.id)
  if (removedIds.length) {
    // 真实有效预约：status 为 pending/confirmed 且未被审核拒绝（与 listSessionReservations 口径一致）
    const cnt = await db.collection(COL.reservations).where({
      projectId, date,
      sessionId: _.in(removedIds),
      status: _.in(['pending', 'confirmed']),
      review: _.neq('rejected')
    }).count().catch(() => ({ total: 0 }))
    if (cnt.total > 0) {
      return fail('该日已有预约，无法清空或删除含预约的场次（请先在「预约管理」取消该日预约）')
    }
  }

  const transaction = await db.startTransaction()
  try {
    // 确保 schedule 文档存在
    const exist = await transaction.collection(COL.schedules).where({ projectId, date }).get()
    if (exist.data[0]) {
      await transaction.collection(COL.schedules).doc(exist.data[0]._id).update({ data: { sessions: clean } })
    } else {
      await transaction.collection(COL.schedules).add({ data: { projectId, date, closed: false, sessions: clean } })
    }
    // 有场次则确保 date 在 openDays（去重合并，避免重复累计同一天）
    if (clean.length) {
      const pDoc = await transaction.collection(COL.projects).doc(projectId).get().catch(() => ({ data: null }))
      const set = new Set((pDoc.data && pDoc.data.openDays) || [])
      set.add(date)
      await transaction.collection(COL.projects).doc(projectId).update({
        data: { openDays: [...set] }
      }).catch(() => {})
    }
    await transaction.commit()
    return ok({ date, sessions: clean })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '保存失败')
  }
}
