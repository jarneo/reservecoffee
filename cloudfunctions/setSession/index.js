// setSession — 场次操作：暂停/恢复/取消全部预约/改名额（owner/manager；改名额仅 owner）
const { db, _, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId, date, sessionId, action, capacity } = event
  if (!projectId || !date || !sessionId || !action) return fail('参数缺失')

  const sch = await db.collection(COL.schedules).where({ projectId, date }).get()
  const schedule = sch.data[0]
  if (!schedule) return fail('该日期无场次')
  const idx = (schedule.sessions || []).findIndex(s => s.id === sessionId)
  if (idx < 0) return fail('场次不存在')

  const transaction = await db.startTransaction()
  try {
    if (action === 'pause') {
      schedule.sessions[idx].paused = true
    } else if (action === 'resume') {
      schedule.sessions[idx].paused = false
    } else if (action === 'changeCap') {
      if (role.role !== 'owner') { await transaction.rollback(); return fail('普通管理员不可修改名额') }
      const cap = Number(capacity)
      if (!(cap >= 0)) { await transaction.rollback(); return fail('名额无效') }
      if (cap < schedule.sessions[idx].booked) { await transaction.rollback(); return fail('名额不可低于已预约人数') }
      schedule.sessions[idx].capacity = cap
    } else if (action === 'cancelAll') {
      // 取消该场次全部有效预约并释放名额
      const rsv = await transaction.collection(COL.reservations).where({
        sessionId, status: _.in(['pending', 'confirmed']), review: _.neq('rejected')
      }).get()
      for (const r of rsv.data) {
        await transaction.collection(COL.reservations).doc(r._id).update({ data: { status: 'cancelled', reviewedAt: Date.now() } })
      }
      schedule.sessions[idx].booked = 0
    } else {
      await transaction.rollback(); return fail('未知操作')
    }
    await transaction.collection(COL.schedules).doc(schedule._id).update({ data: { sessions: schedule.sessions } })
    await transaction.commit()
    return ok({ sessions: schedule.sessions })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '操作失败')
  }
}
