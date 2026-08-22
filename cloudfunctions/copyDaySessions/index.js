// copyDaySessions — 复制某日场次到目标日期（owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

function ymd(t) { return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` }
function parse(y) { const [a, m, d] = y.split('-').map(Number); return new Date(a, m - 1, d) }

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可复制场次')

  const { projectId, fromDate, target } = event
  if (!projectId || !fromDate || !target) return fail('参数缺失')

  const src = await db.collection(COL.schedules).where({ projectId, date: fromDate }).get()
  const srcSched = src.data[0]
  if (!srcSched) return fail('源日期无场次可复制')
  // 复制生成全新场次（新 id，booked 归零）
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
    // 当月「所有可预约日」：取项目 openDays 中落在 from 年月的日期（去重）
    const pRes = await db.collection(COL.projects).doc(projectId).get().catch(() => ({ data: null }))
    const openDays = (pRes.data && pRes.data.openDays) || []
    const ym = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`
    targets = [...new Set(openDays.filter(d => typeof d === 'string' && d.indexOf(ym) === 0))]
  } else if (target === 'all') {
    for (let i = 1; i <= 6; i++) {
      const t = new Date(from.getFullYear(), from.getMonth() + i, from.getDate())
      targets.push(ymd(t))
    }
  } else {
    return fail('未知 target')
  }

  // 排除源日期本身（避免误清源日已有预约），并只复制到「今天及以后」的日期
  const today = ymd(new Date())
  targets = [...new Set(targets)].filter(d => d !== fromDate && d >= today)

  if (!targets.length) return fail('没有可复制的目标日期（目标均为今天之前或仅源日期本身）')

  const transaction = await db.startTransaction()
  try {
    for (const d of targets) {
      const exist = await transaction.collection(COL.schedules).where({ projectId, date: d }).get()
      // 清空当日配置后，完整写入源场次（clear-then-copy，保证全部源场次被复制）
      if (exist.data[0]) {
        await transaction.collection(COL.schedules).doc(exist.data[0]._id).update({ data: { sessions } })
      } else {
        await transaction.collection(COL.schedules).add({ data: { projectId, date: d, closed: false, sessions } })
      }
    }
    // 去重合并 openDays（不重复累计）
    const pDoc = await transaction.collection(COL.projects).doc(projectId).get().catch(() => ({ data: null }))
    const set = new Set((pDoc.data && pDoc.data.openDays) || [])
    targets.forEach(d => set.add(d))
    await transaction.collection(COL.projects).doc(projectId).update({ data: { openDays: [...set] } }).catch(() => {})
    await transaction.commit()
    return ok({ targets, copied: sessions.length })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '复制失败')
  }
}
