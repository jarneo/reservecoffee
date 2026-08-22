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

  // 分页拉取，规避云端查询默认上限（默认最多 ~20/100 条），确保多日场次（含复制新增的）全部返回
  const raw = []
  let skip = 0
  while (true) {
    const res = await db.collection(COL.schedules).where(where).orderBy('date', 'asc').skip(skip).limit(100).get()
    const batch = res.data || []
    raw.push(...batch)
    if (batch.length < 100) break
    skip += 100
  }

  const schedules = raw.map(s => ({
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
