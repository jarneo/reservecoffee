// getBookingBoard — 管理端「预约情况」看板（owner/manager）
// 一次返回未来 N 天的**全部**数据：已发布项目（列）+ 每日「场次时段 × 项目」的已约/容量矩阵。
// 前端切日期不再发请求（数据量很小：14 天 × 若干项目 × 若干场次）。
//
// 为什么单独开一个函数而不是复用 getSchedule：getSchedule 一次只能查**一个项目**，
// 要凑出这张表得按项目循环调用 N 次（N 次 DB 往返 + N 次网络往返），首屏会很慢。
// 这里用 `projectId: _.in(ids)` 合并成 1 次查询。
//
// ⚠️ 口径：只统计**已发布**项目（published:true 且未删除），与顾客端首页同源；
//    项目被 paused 仍会展示（管理员需要看见），但场次标 paused 由前端置灰。
const { db, _, COL, ok, fail, wxCtx, getRole, ymd, addDays } = require('./lib')

const DAYS = 14 // 窗口天数（与管理端「预约管理」的日期条跨度一致）

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (!role || !['owner', 'manager'].includes(role.role)) return fail('无权限')

  const today = ymd(new Date())
  const winEnd = addDays(DAYS - 1)

  // 1) 已发布且未删除的项目（与 getHomepage 同一口径）
  const pres = await db.collection(COL.projects)
    .where({ published: true, deleted: _.neq(true) })
    .orderBy('createdAt', 'asc').get()
    .catch(() => ({ data: [] }))
  const projects = (pres.data || []).map(p => ({
    _id: p._id, name: p.name || '未命名', paused: !!p.paused
  }))
  if (!projects.length) return ok({ today, projects: [], days: [], board: {} })

  const ids = projects.map(p => p._id)
  const idxOf = {}
  projects.forEach((p, i) => { idxOf[p._id] = i })

  // 2) 窗口内所有项目的 schedules：一次查询 + 分页累积（CloudBase 单批上限 100）
  const raw = []
  let skip = 0
  while (true) {
    const r = await db.collection(COL.schedules)
      .where({ projectId: _.in(ids), date: _.gte(today).and(_.lte(winEnd)) })
      .orderBy('date', 'asc').skip(skip).limit(100).get()
      .catch(() => ({ data: [] }))
    const b = r.data || []
    raw.push(...b)
    if (b.length < 100) break
    skip += 100
  }

  // 3) 按日期聚合：date -> { 'HH:mm-HH:mm': [项目下标 -> session] }
  const byDate = {}
  raw.forEach(s => {
    if (!s || s.closed) return // 休市日不进看板（与顾客端首页一致）
    const d = s.date
    if (!d || d < today || d > winEnd) return
    const pi = idxOf[s.projectId]
    if (pi === undefined) return
    if (!byDate[d]) byDate[d] = {}
    ;(s.sessions || []).forEach(x => {
      const key = String(x.start || '') + '-' + String(x.end || '')
      if (!byDate[d][key]) byDate[d][key] = []
      byDate[d][key][pi] = {
        sid: x.id || '',
        booked: Number(x.booked) || 0,
        capacity: Number(x.capacity) || 0,
        paused: !!x.paused
      }
    })
  })

  // 4) 组装 board：行 = 时段并集（按开始时间升序），列 = 项目
  const board = {}
  Object.keys(byDate).sort().forEach(d => {
    const map = byDate[d]
    const keys = Object.keys(map).sort((a, b) => (a.split('-')[0] || '').localeCompare(b.split('-')[0] || ''))
    const rows = []
    let people = 0
    let sessions = 0
    const totals = projects.map(() => 0) // 每项目当日已约人数
    keys.forEach(k => {
      const arr = map[k]
      const cells = projects.map((_, i) => arr[i] || null)
      cells.forEach((c, i) => {
        if (!c) return
        totals[i] += c.booked
        people += c.booked
        sessions++
      })
      rows.push({ tm: k, cells })
    })
    board[d] = { rows, totals, people, sessions }
  })

  // 5) 日期条：窗口内每一天都给，has 标记当天是否真有场次（无场次的灰掉但仍占位，便于对齐星期）
  const days = []
  for (let i = 0; i < DAYS; i++) {
    const d = addDays(i)
    days.push({ date: d, has: !!board[d] })
  }

  return ok({ today, projects, days, board })
}
