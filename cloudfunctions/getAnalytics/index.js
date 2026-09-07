// getAnalytics — 数据分析看板聚合（owner）
// 板块1 总览 / 板块2 转化漏斗（4层，含前端埋点）/ 板块3 用户分层 / 板块4 项目维度
//      / 板块5 时间趋势 / 板块6 预约时段 / 板块7 提前预约 / 板块9 用户维度·项目交叉
// ⚠️ 板块8「场次时长分析」已按需求移除（slot 统计一并删除）。
// ⚠️ 埋点：events 集合 {openid,type,projectId,createdAt}，type ∈ visit|view_project|click_book
//    events 集合不存在或为空时，漏斗上层 UV 如实为 0，不再有"待埋点"占位。
// ⚠️ 时区：云函数默认 UTC，时段/日期一律按 Asia/Shanghai(+8h) 归一，否则"20:00 最热"会偏成"12:00"。
const { db, _, COL, ok, fail, wxCtx, getRole } = require('./lib')

function shDay(ts) { return new Date(ts + 8 * 3600 * 1000) }      // 返回 Date，其 getUTC* = 上海本地
function shYmd(ts) { return shDay(ts).toISOString().slice(0, 10) } // 上海当地日期 YYYY-MM-DD
const shHour = (ts) => (new Date(ts).getUTCHours() + 8) % 24       // 上海当地小时 0-23
function ymdMid(ts) { return Date.parse(shYmd(ts) + 'T00:00:00Z') } // 上海当地 0 点（UTC 时间戳）

// 提前天数：到店日(date, 上海本地 YYYY-MM-DD) − 提交日(上海本地 0 点)
function leadDays(dateStr, ts) {
  if (!dateStr) return null
  const to = Date.parse(dateStr + 'T00:00:00+08:00')
  if (isNaN(to)) return null
  return Math.round((to - ymdMid(ts)) / 86400000)
}
function leadBucket(d) {
  if (d == null || d < 0) d = 0
  if (d <= 0) return '当天'
  if (d === 1) return '1天'
  if (d === 2) return '2天'
  if (d === 3) return '3天'
  if (d <= 7) return '4-7天'
  if (d <= 14) return '8-14天'
  return '15+天'
}
const LEAD_ORDER = ['当天', '1天', '2天', '3天', '4-7天', '8-14天', '15+天']

// 有效预约口径：排除已取消/过期，排除审核拒绝
function isValid(r) {
  return ['pending', 'confirmed', 'completed'].includes(r.status) && r.review !== 'rejected'
}
// 项目短名：去掉「预约」后缀，便于组合标签（如「法兰绒深烘咖啡 + 清酒品鉴」）
const shortName = (n) => String(n || '未命名').replace(/预约$/, '')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可查看分析')

  const period = (event && event.period) || '30'
  const periodDays = period === '7' ? 7 : period === '30' ? 30 : 0
  const to = Date.now()
  const from = periodDays ? to - periodDays * 86400000 : 0

  // ===== 取数：reservations（取全量：周期过滤 + 首单时间都要用） =====
  const rows = []
  let skip = 0
  const LIMIT = 100
  for (let i = 0; i < 50; i++) {
    const res = await db.collection(COL.reservations)
      .orderBy('createdAt', 'desc').skip(skip).limit(LIMIT).get()
      .catch(() => ({ data: [] }))
    const batch = res.data || []
    rows.push(...batch)
    if (batch.length < LIMIT) break
    skip += LIMIT
    if (rows.length > 4000) break
  }
  const list = rows.filter(r => { const t = r.createdAt || 0; return t >= from && t <= to })

  // ===== 取数：events（前端埋点；集合可能不存在，失败按空处理） =====
  const evRows = []
  skip = 0
  for (let i = 0; i < 50; i++) {
    const res = await db.collection('events')
      .orderBy('createdAt', 'desc').skip(skip).limit(LIMIT).get()
      .catch(() => ({ data: [] }))
    const batch = res.data || []
    evRows.push(...batch)
    if (batch.length < LIMIT) break
    skip += LIMIT
    if (evRows.length > 8000) break
  }
  // 管理员/超级管理员 openid 集合：统计时剔除其访问埋点，避免 owner/manager 自测污染漏斗/访问UV/只看不约
  const adminRes = await db.collection(COL.admins).where({ role: _.in(['owner', 'manager']) }).get().catch(() => ({ data: [] }))
  const adminSet = new Set((adminRes.data || []).map(a => a.openid).filter(Boolean))

  const visitSet = new Set(), viewSet = new Set(), clickSet = new Set()
  evRows.forEach(e => {
    const t = e.createdAt || 0
    if (t < from || t > to) return
    const u = e.openid || ''
    if (adminSet.has(u)) return          // 剔除管理员/超级管理员访问
    if (e.type === 'visit') visitSet.add(u)
    else if (e.type === 'view_project') viewSet.add(u)
    else if (e.type === 'click_book') clickSet.add(u)
  })

  // ===== 首单时间（基于全量 rows，用于判断新用户） =====
  const firstAt = {}
  for (const r of rows) {
    if (!isValid(r)) continue
    const uid = r.openid || ''
    const t = r.createdAt || 0
    if (!firstAt[uid] || t < firstAt[uid]) firstAt[uid] = t
  }

  // ===== 周期内累加 =====
  const uvSet = new Set()
  const userCnt = {}                 // openid -> 有效次数
  const userProjects = {}            // openid -> Set(projectId)，用户维度交叉分析用
  const projAcc = {}
  const trend = {}
  const submitHour = new Array(24).fill(0)
  const leadCount = {}
  let totalPeople = 0

  for (const r of list) {
    if (!isValid(r)) continue
    const uid = r.openid || ''
    uvSet.add(uid)
    totalPeople += Number(r.partySize) || 0
    userCnt[uid] = (userCnt[uid] || 0) + 1

    const pid = r.projectId || 'unknown'
    if (!userProjects[uid]) userProjects[uid] = new Set()
    userProjects[uid].add(pid)

    if (r.createdAt) submitHour[shHour(r.createdAt)]++

    if (!projAcc[pid]) projAcc[pid] = { cnt: 0, uv: new Set(), lead: [], submitH: new Array(24).fill(0) }
    const p = projAcc[pid]
    p.cnt++
    p.uv.add(uid)
    if (r.createdAt) p.submitH[shHour(r.createdAt)]++

    const ld = leadDays(r.date, r.createdAt || 0)
    if (ld != null) { const b = leadBucket(ld); leadCount[b] = (leadCount[b] || 0) + 1; p.lead.push(ld) }

    const d = shYmd(r.createdAt)
    if (!trend[d]) trend[d] = { cnt: 0, uv: new Set() }
    trend[d].cnt++
    trend[d].uv.add(uid)
  }

  const orders = Object.values(userCnt).reduce((a, b) => a + b, 0)
  const uv = uvSet.size

  // 用户分层（按 openid 有效次数）
  let t1 = 0, t2 = 0, t3 = 0
  for (const k in userCnt) {
    const n = userCnt[k]
    if (n >= 3) t3++
    else if (n === 2) t2++
    else t1++
  }

  // 只看不约（0次）：周期内访问过、但没有任何有效预约的用户（依赖埋点 events）
  let t0 = 0
  for (const uid of visitSet) { if (!uvSet.has(uid)) t0++ }

  // 新用户：本周期内有预约，且首单时间也落在本周期内
  let newUsers = 0
  for (const uid of uvSet) { if ((firstAt[uid] || 0) >= from) newUsers++ }

  // 项目名映射
  const projRes = await db.collection(COL.projects).get().catch(() => ({ data: [] }))
  const projName = {}
  ;(projRes.data || []).forEach(p => { projName[p._id] = p.name || '未命名项目' })

  // 项目维度
  const byProject = Object.keys(projAcc).map(pid => {
    const p = projAcc[pid]
    const avgLead = p.lead.length ? p.lead.reduce((a, b) => a + b, 0) / p.lead.length : 0
    const peak = (arr) => { let hi = 0; for (let i = 1; i < 24; i++) if (arr[i] > arr[hi]) hi = i; return arr[hi] > 0 ? hi : -1 }
    return {
      projectId: pid,
      name: projName[pid] || '未命名项目',
      uv: p.uv.size,
      cnt: p.cnt,
      ratio: orders ? +(p.cnt / orders * 100).toFixed(1) : 0,
      perCap: p.uv.size ? +(p.cnt / p.uv.size).toFixed(2) : 0,
      avgLeadDays: +avgLead.toFixed(1),
      submitPeakHour: peak(p.submitH)
    }
  }).sort((a, b) => b.cnt - a.cnt)

  const trendArr = Object.keys(trend).sort().map(d => ({ date: d, cnt: trend[d].cnt, uv: trend[d].uv.size }))
  const leadDist = LEAD_ORDER.map(label => ({ label, cnt: leadCount[label] || 0 }))
  const leadTotal = leadDist.reduce((a, b) => a + b.cnt, 0) || 1

  let leadAll = 0, leadN = 0
  for (const b in leadCount) leadAll += leadCount[b] * LEAD_ORDER.indexOf(b)
  for (const lab of LEAD_ORDER) leadN += leadCount[lab] || 0
  const avgLeadDays = leadN ? +(leadAll / leadN).toFixed(1) : 0

  // 临时型 ≤1天 / 计划型 ≥3天
  const tmp = (leadCount['当天'] || 0) + (leadCount['1天'] || 0)
  const planned = (leadCount['3天'] || 0) + (leadCount['4-7天'] || 0) + (leadCount['8-14天'] || 0) + (leadCount['15+天'] || 0)

  // ===== 板块2 漏斗（埋点后 4 层全部真实） =====
  const visitUV = visitSet.size, viewUV = viewSet.size, clickUV = clickSet.size, submitUV = uv
  const fTop = Math.max(visitUV, viewUV, clickUV, submitUV, 1)
  const mk = (key, label, n) => ({ key, label, uv: n, pct: Math.round(n / fTop * 100) })
  const funnel = [
    mk('visit', '访问小程序', visitUV),
    mk('view', '查看项目详情', viewUV),
    mk('click', '点击预约', clickUV),
    mk('submit', '提交预约', submitUV)
  ]
  const rate = (a, b) => (a ? +(b / a * 100).toFixed(1) : 0)
  const funnelRate = {
    visitToView: rate(visitUV, viewUV),
    viewToClick: rate(viewUV, clickUV),
    clickToSubmit: rate(clickUV, submitUV),
    overall: rate(visitUV, submitUV)
  }

  // ===== 板块9 用户维度 · 项目交叉分析 =====
  // 组合分布：按「用户实际约过的项目集合」分组（仅咖啡 / 咖啡+清酒 / 三项全约 …）
  const projIds = Object.keys(projAcc)
  const comboMap = {}
  let multiUsers = 0
  for (const uid in userProjects) {
    const set = userProjects[uid]
    if (set.size >= 2) multiUsers++
    const key = Array.from(set).sort().join('|')
    comboMap[key] = (comboMap[key] || 0) + 1
  }
  const combos = Object.keys(comboMap).map(k => {
    const ids = k.split('|')
    const names = ids.map(id => shortName(projName[id]))
    return {
      label: ids.length === 1 ? '仅' + names[0] : names.join(' + '),
      uv: comboMap[k],
      pct: uv ? +(comboMap[k] / uv * 100).toFixed(1) : 0
    }
  }).sort((a, b) => b.uv - a.uv)

  // 各项目触达用户（人数口径，非订单数）
  const reach = projIds.map(pid => ({
    projectId: pid,
    name: shortName(projName[pid]),
    uv: projAcc[pid].uv.size,
    pct: uv ? +(projAcc[pid].uv.size / uv * 100).toFixed(1) : 0
  })).sort((a, b) => b.uv - a.uv)

  // 两两重叠：同时约过两个项目的用户（可同时含第三个）
  const pairs = []
  for (let i = 0; i < projIds.length; i++) {
    for (let j = i + 1; j < projIds.length; j++) {
      const a = projIds[i], b = projIds[j]
      let n = 0
      for (const uid in userProjects) {
        const s = userProjects[uid]
        if (s.has(a) && s.has(b)) n++
      }
      pairs.push({
        label: shortName(projName[a]) + ' × ' + shortName(projName[b]),
        uv: n,
        pct: uv ? +(n / uv * 100).toFixed(1) : 0
      })
    }
  }
  pairs.sort((a, b) => b.uv - a.uv)

  return ok({
    scope: { period, from, to, total: rows.length, used: list.length, events: evRows.length },
    kpi: {
      uv,
      orders,
      perCap: uv ? +(orders / uv).toFixed(2) : 0,
      totalPeople,
      visitUV,
      newUserPct: uv ? +(newUsers / uv * 100).toFixed(0) : 0
    },
    funnel, funnelRate,
    tiers: { t1, t2, t3, t0, total: t1 + t2 + t3 },
    byProject,
    trend: trendArr,
    submitHour,
    leadDist,
    avgLeadDays,
    leadRatio: {
      temporary: +((tmp / leadTotal) * 100).toFixed(0),
      planned: +((planned / leadTotal) * 100).toFixed(0)
    },
    submitPeakHour: (() => { let hi = 0; for (let i = 1; i < 24; i++) if (submitHour[i] > submitHour[hi]) hi = i; return submitHour[hi] > 0 ? hi : -1 })(),
    cross: {
      reach, combos, pairs,
      multi: { uv: multiUsers, pct: uv ? +(multiUsers / uv * 100).toFixed(1) : 0 }
    }
  })
}
