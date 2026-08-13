// copyDaySessions — 复制某日场次到目标日期（owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

function ymd(t) { return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` }
function parse(y) { const [a, m, d] = y.split('-').map(Number); return new Date(a, m - 1, d) }
function sameWeekdayInMonth(from, year, month) {
  // 当月内与 from 同星期、且日期 >= from 的日期
  const res = []
  const wd = from.getDay()
  const max = new Date(year, month + 1, 0).getDate()
  for (let d = from.getDate(); d <= max; d++) {
    const dt = new Date(year, month, d)
    if (dt.getDay() === wd) res.push(ymd(dt))
  }
  return res
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可复制场次')

  const { projectId, fromDate, target } = event
  if (!projectId || !fromDate || !target) return fail('参数缺失')

  const src = await db.collection(COL.schedules).where({ projectId, date: fromDate }).get()
  const srcSched = src.data[0]
  if (!srcSched) return fail('源日期无场次可复制')
  const sessions = (srcSched.sessions || []).map(s => ({
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    start: s.start, end: s.end, capacity: s.capacity, booked: 0, paused: !!s.paused, desc: s.desc || ''
  }))

  const from = parse(fromDate)
  let targets = []
  if (target === 'nextWeek') {
    const t = new Date(from); t.setDate(t.getDate() + 7); targets = [ymd(t)]
  } else if (target === 'nextMonth') {
    const t = new Date(from.getFullYear(), from.getMonth() + 1, from.getDate()); targets = [ymd(t)]
  } else if (target === 'month') {
    targets = sameWeekdayInMonth(from, from.getFullYear(), from.getMonth())
  } else if (target === 'all') {
    for (let i = 1; i <= 6; i++) {
      const t = new Date(from.getFullYear(), from.getMonth() + i, from.getDate())
      targets.push(ymd(t))
    }
  } else {
    return fail('未知 target')
  }

  const transaction = await db.startTransaction()
  try {
    for (const d of targets) {
      const exist = await transaction.collection(COL.schedules).where({ projectId, date: d }).get()
      if (exist.data[0]) {
        await transaction.collection(COL.schedules).doc(exist.data[0]._id).update({ data: { sessions } })
      } else {
        await transaction.collection(COL.schedules).add({ data: { projectId, date: d, closed: false, sessions } })
      }
    }
    await transaction.collection(COL.projects).doc(projectId).update({
      data: { openDays: db.command.push(targets) }
    }).catch(() => {})
    await transaction.commit()
    return ok({ targets, copied: sessions.length })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '复制失败')
  }
}
