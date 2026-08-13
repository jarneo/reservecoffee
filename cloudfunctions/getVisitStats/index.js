// getVisitStats — 访问统计（owner），按日期区间聚合
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可查看统计')

  const { from, to } = event
  if (!from || !to) return fail('缺少日期区间')
  const where = { _id: db.command.gte(from) }
  // _id 为日期字符串 YYYY-MM-DD，可直接比较
  const res = await db.collection(COL.stats).where({ _id: db.command.and(db.command.gte(from), db.command.lte(to)) }).get()

  const days = (res.data || []).map(s => ({
    date: s._id, visitUsers: s.visitUsers || 0, newUsers: s.newUsers || 0, pv: s.pv || 0
  }))
  const total = days.reduce((a, b) => ({
    visitUsers: a.visitUsers + b.visitUsers,
    newUsers: a.newUsers + b.newUsers,
    pv: a.pv + b.pv
  }), { visitUsers: 0, newUsers: 0, pv: 0 })

  // 区间预约数
  const rsv = await db.collection(COL.reservations)
    .where({ date: db.command.and(db.command.gte(from), db.command.lte(to)) }).count()

  return ok({ days, total, reservationCount: rsv.total })
}
