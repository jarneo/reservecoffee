// getProject — 单项目详情 + 全部日期场次（顾客端选日期/场次用）
const { db, COL, ok, fail } = require('./lib')

exports.main = async (event) => {
  const { projectId } = event
  if (!projectId) return fail('缺少 projectId')

  const pRes = await db.collection(COL.projects).doc(projectId).get().catch(() => ({ data: null }))
  const p = pRes.data
  if (!p || !p.published) return fail('项目不存在或未发布')

  const sch = await db.collection(COL.schedules)
    .where({ projectId })
    .orderBy('date', 'asc')
    .get()

  const schedules = (sch.data || []).map(s => ({
    date: s.date,
    sessions: (s.sessions || []).map(x => ({
      id: x.id,
      start: x.start,
      end: x.end,
      capacity: x.capacity,
      booked: x.booked,
      paused: !!x.paused,
      desc: x.desc || ''
    }))
  }))

  const project = {
    _id: p._id,
    name: p.name,
    icon: p.icon,
    image: p.image,
    intro: p.intro,
    needReview: !!p.needReview,
    dailyLimit: p.dailyLimit || 1,
    advanceDays: p.advanceDays || 7,
    openDays: p.openDays || [],
    useSlotTemplate: !!p.useSlotTemplate,
    slotTemplate: p.slotTemplate || []
  }

  return ok({ project, schedules })
}
