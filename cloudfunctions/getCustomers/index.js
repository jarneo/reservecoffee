// getCustomers — 顾客名录（预约人明细）聚合
// owner/manager 可见；按 openid 聚合预约次数/首末约/各项目/平均提前，合并 users 资料，算自动标签。
// 2026-09-06 扩展：新增每用户筛选/排序字段，支撑名录页固定条件（当日预约/当天取消/黑名单/跨项目/新客）
//   与排序（预约最多/最近预约/最早预约/取消最多）：
//   hasTodayReserve（今日有未取消预约）、cancelToday（今日取消数）、cancelCount（累计取消数）、
//   projectCount（约过项目数）、isNew（首单在 30 天内）。
const { db, _, $, COL, ok, fail, wxCtx, getRole, customerTags } = require('./lib')

// 上海当地日期 YYYY-MM-DD（云函数默认 UTC，须 +8h 归一，否则「今日」会偏成昨天/明天）
function shYmd(ts) {
  if (!ts) return ''
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (!role || !['owner', 'manager'].includes(role.role)) return fail('无权限')

  const page = Math.max(1, Number(event && event.page) || 1)
  const size = 100
  const skip = (page - 1) * size

  // 1) 两级 group：先按 openid+projectId，再按 openid 汇总；平均提前用 date−createdAt(ms)
  const agg = await db.collection(COL.reservations).aggregate()
    .project({
      openid: 1,
      projectId: 1,
      createdAt: 1,
      partySize: 1,
      leadMs: $.subtract([
        $.dateFromString({ dateString: '$date', format: '%Y-%m-%d' }),
        '$createdAt'
      ])
    })
    .group({
      _id: { openid: '$openid', projectId: '$projectId' },
      cnt: $.sum(1),
      firstAt: $.min('$createdAt'),
      lastAt: $.max('$createdAt'),
      avgParty: $.avg('$partySize'),
      avgLeadMs: $.avg('$leadMs')
    })
    .group({
      _id: '$_id.openid',
      total: $.sum('$cnt'),
      firstAt: $.min('$firstAt'),
      lastAt: $.max('$lastAt'),
      avgParty: $.avg('$avgParty'),
      avgLeadMs: $.avg('$avgLeadMs'),
      perProject: $.push({ projectId: '$_id.projectId', cnt: '$cnt' })
    })
    .skip(skip)
    .limit(size)
    .end()

  const rows = (agg && agg.list) || []
  if (!rows.length) return ok({ list: [], page, hasMore: false })

  // 2) 每用户逐条预约（date/status/reviewedAt），用于「当日预约/当天取消/取消次数」
  const recAgg = await db.collection(COL.reservations).aggregate()
    .group({
      _id: '$openid',
      recs: $.push({ date: '$date', status: '$status', reviewedAt: '$reviewedAt' })
    })
    .end()
  const recMap = {}
  ;(recAgg && recAgg.list || []).forEach(x => { recMap[x._id] = x.recs || [] })

  const today = shYmd(Date.now())
  const recFields = (recs) => {
    let hasTodayReserve = false
    let cancelToday = 0
    let cancelCount = 0
    for (const r of recs) {
      if (r.status === 'cancelled') {
        cancelCount++
        if (shYmd(r.reviewedAt) === today) cancelToday++
      } else if (r.date === today) {
        hasTodayReserve = true
      }
    }
    return { hasTodayReserve, cancelToday, cancelCount }
  }

  const openids = rows.map(r => r._id)

  // 3) 批量取 users 资料
  const usersRes = await db.collection(COL.users).where({ _id: _.in(openids) }).get().catch(() => ({ data: [] }))
  const userMap = {}
  ;(usersRes.data || []).forEach(u => { userMap[u._id] = u })

  // 4) 项目名映射
  const projRes = await db.collection(COL.projects).get().catch(() => ({ data: [] }))
  const projMap = {}
  ;(projRes.data || []).forEach(p => { projMap[p._id] = p.name })

  const list = rows.map(r => {
    const u = userMap[r._id] || {}
    const perProject = (r.perProject || []).map(x => ({ projectId: x.projectId, name: projMap[x.projectId] || '', cnt: x.cnt }))
    const aggObj = {
      total: r.total,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
      avgParty: r.avgParty,
      avgLeadDays: (r.avgLeadMs || 0) / 86400000,
      perProject
    }
    const autoTags = customerTags(u, aggObj)
    const rf = recFields(recMap[r._id] || [])
    return {
      openid: r._id,
      name: u.name || '',
      phone: u.phone || '',
      firstLaunchAt: u.firstLaunchAt || 0,
      firstSource: u.firstSource || '',
      remark: u.remark || '',
      tags: u.tags || [],
      isBlacklisted: !!u.isBlacklisted,
      blacklistReason: u.blacklistReason || '',
      total: r.total,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
      autoTags,
      // —— 新增筛选/排序字段 ——
      projectCount: perProject.length,
      cancelCount: rf.cancelCount,
      cancelToday: rf.cancelToday,
      hasTodayReserve: rf.hasTodayReserve,
      isNew: r.firstAt ? (Date.now() - r.firstAt < 30 * 86400000) : false
    }
  })

  // 默认按累计次数倒序，便于管理
  list.sort((a, b) => (b.total || 0) - (a.total || 0))

  return ok({ list, page, hasMore: rows.length === size })
}
