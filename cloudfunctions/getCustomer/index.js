// getCustomer — 单用户分析（owner/manager 可见）
// 返回 users 资料 + 该用户预约聚合（次数/首末约/各项目/平均提前/时段/周末占比）+ 自动标签 + 最近预约。
const { db, COL, ok, fail, wxCtx, getRole, customerTags } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (!role || !['owner', 'manager'].includes(role.role)) return fail('无权限')

  const target = (event && event.openid) || ''
  if (!target) return fail('缺少 openid')

  const u = await db.collection(COL.users).doc(target).get().catch(() => null)
  const profile = (u && u.data) ? u.data : { openid: target }

  const baseProfile = {
    openid: target,
    name: profile.name || '',
    phone: profile.phone || '',
    remark: profile.remark || '',
    tags: profile.tags || [],
    isBlacklisted: !!profile.isBlacklisted,
    blacklistReason: profile.blacklistReason || '',
    firstLaunchAt: profile.firstLaunchAt || 0,
    firstSource: profile.firstSource || ''
  }

  const res = await db.collection(COL.reservations).where({ openid: target }).limit(1000).get().catch(() => ({ data: [] }))
  const list = (res && res.data) || []
  const total = list.length

  if (!total) {
    return ok({ profile: baseProfile, agg: null, autoTags: [], recent: [] })
  }

  let firstAt = Infinity, lastAt = -Infinity, partySum = 0, leadSum = 0, weekend = 0
  const perProjectMap = {}
  const submitHour = new Array(24).fill(0)
  const sessionHour = new Array(24).fill(0)

  list.forEach(r => {
    const ca = r.createdAt || 0
    if (ca < firstAt) firstAt = ca
    if (ca > lastAt) lastAt = ca
    partySum += Number(r.partySize) || 1
    const [y, m, d] = String(r.date || '').split('-').map(Number)
    if (y) {
      const dateTs = new Date(y, m - 1, d).getTime()
      leadSum += (dateTs - ca) / 86400000
      const wd = new Date(y, m - 1, d).getDay()
      if (wd === 0 || wd === 6) weekend++
    }
    perProjectMap[r.projectId] = (perProjectMap[r.projectId] || 0) + 1
    // 提交时段：createdAt 为 UTC 毫秒，按 Asia/Shanghai +8 归一
    submitHour[(new Date(ca).getHours() + 8) % 24]++
    const [hh] = String(r.sessionStart || '').split(':').map(Number)
    if (!isNaN(hh)) sessionHour[hh]++ // sessionStart 已是本地 HH:MM，直接用
  })

  // 项目名映射
  const projRes = await db.collection(COL.projects).get().catch(() => ({ data: [] }))
  const projMap = {}
  ;(projRes.data || []).forEach(p => { projMap[p._id] = p.name })

  const perProject = Object.keys(perProjectMap).map(pid => ({ projectId: pid, name: projMap[pid] || '', cnt: perProjectMap[pid] }))

  const agg = {
    total,
    firstAt: firstAt === Infinity ? 0 : firstAt,
    lastAt: lastAt === -Infinity ? 0 : lastAt,
    avgParty: partySum / total,
    avgLeadDays: leadSum / total,
    weekendRatio: weekend / total,
    perProject,
    submitHour,
    sessionHour
  }

  const autoTags = customerTags(profile, agg)

  const recent = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20).map(r => ({
    _id: r._id,
    date: r.date,
    sessionStart: r.sessionStart,
    sessionEnd: r.sessionEnd,
    partySize: r.partySize,
    status: r.status,
    review: r.review,
    projectId: r.projectId,
    projectName: projMap[r.projectId] || ''
  }))

  return ok({ profile: baseProfile, agg, autoTags, recent })
}
