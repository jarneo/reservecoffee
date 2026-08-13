// getSchedule — 读取某项目的日历/单日场次（owner/manager）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId, date } = event
  if (!projectId) return fail('缺少 projectId')

  const where = { projectId }
  if (date) where.date = date
  const res = await db.collection(COL.schedules).where(where).orderBy('date', 'asc').get()

  const schedules = (res.data || []).map(s => ({
    _id: s._id,
    date: s.date,
    closed: !!s.closed,
    sessions: (s.sessions || []).map(x => ({
      id: x.id, start: x.start, end: x.end,
      capacity: x.capacity, booked: x.booked, paused: !!x.paused, desc: x.desc || ''
    }))
  }))
  return ok({ schedules })
}
