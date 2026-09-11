// listMyReservations — 顾客端「我的预约」（返回五态有效状态）
// 过期判定统一走共享库 effStatus —— 内部用 Date.UTC(...) − 8h 还原北京时间真实时刻。
// ⚠️ 云函数容器时区是 **UTC**，而 date / sessionEnd 存的是**北京时间**字符串；
//    若用 `new Date('2026-09-11 20:00')`（按容器本地时区解析），UTC 下等于「北京 09-12 04:00」，
//    会让「已过期」整体延后 8 小时（表现为：前一天晚上结束的预约，到次日凌晨仍显示「预约成功」）。
const { db, COL, ok, wxCtx, effStatus } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  if (!OPENID) return ok({ list: [] })

  const res = await db.collection(COL.reservations)
    .where({ openid: OPENID })
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get()

  // 关联项目名称
  const projIds = [...new Set((res.data || []).map(r => r.projectId))]
  const projs = await db.collection(COL.projects)
    .where({ _id: db.command.in(projIds) }).get()
  const nameMap = {}
  projs.data.forEach(p => { nameMap[p._id] = p.name })

  const list = (res.data || []).map(r => ({
    _id: r._id,
    projectId: r.projectId,
    projectName: nameMap[r.projectId] || '',
    date: r.date,
    time: `${r.sessionStart || ''}–${r.sessionEnd || ''}`,
    partySize: r.partySize,
    name: r.name,
    status: effStatus(r),
    review: r.review,
    canCancel: ['pending', 'confirmed'].includes(effStatus(r))
  }))

  return ok({ list })
}
