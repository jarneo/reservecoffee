// setDaySessions — 设定某日场次（owner；同时将该日并入 openDays）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

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

  const transaction = await db.startTransaction()
  try {
    // 确保 schedule 文档存在
    const exist = await transaction.collection(COL.schedules).where({ projectId, date }).get()
    if (exist.data[0]) {
      await transaction.collection(COL.schedules).doc(exist.data[0]._id).update({ data: { sessions: clean } })
    } else {
      await transaction.collection(COL.schedules).add({ data: { projectId, date, closed: false, sessions: clean } })
    }
    // 有场次则确保 date 在 openDays
    if (clean.length) {
      await transaction.collection(COL.projects).doc(projectId).update({
        data: { openDays: db.command.push(date) }
      }).catch(() => {})
    }
    await transaction.commit()
    return ok({ date, sessions: clean })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '保存失败')
  }
}
