// listDateReservations — 查看某日全部场次的预约人（一次性加载，按 sessionId 分组返回；owner/manager）
// 与 listSessionReservations 的区别：后者按单个 sessionId 取，本函数一次取「整日所有场次」并分组，
// 供管理端「预约管理」选中日期后把预约人直接挂到对应场次下（无需逐场点击）。
// 查询条件、返回字段、黑名单映射与 listSessionReservations 保持一致，便于后续统一维护。
const { db, _, COL, ok, fail, wxCtx, getRole } = require('./lib')

// 批量取 users 的黑名单状态；openid 分片（CloudBase 单批上限 100）
async function blacklistMap(openids) {
  const map = {}
  const ids = [...new Set(openids.filter(Boolean))]
  if (!ids.length) return map
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const res = await db.collection(COL.users)
      .where({ _id: _.in(chunk) })
      .limit(100)
      .get()
      .catch(() => ({ data: [] }))
    ;(res.data || []).forEach(u => {
      map[u._id] = { isBlacklisted: !!u.isBlacklisted, blacklistReason: u.blacklistReason || '' }
    })
  }
  return map
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId, date } = event
  if (!date) return fail('缺少 date')
  if (!projectId) return fail('缺少 projectId')

  // 仅显示有效预约：未取消 + 未审核拒绝（与 listSessionReservations 一致）
  const where = {
    date,
    projectId,
    status: _.in(['pending', 'confirmed']),
    review: _.neq('rejected')
  }

  // CloudBase 单批上限 100；整日可能超过，分页累积
  const rows = []
  let skip = 0
  while (true) {
    const res = await db.collection(COL.reservations)
      .where(where)
      .orderBy('createdAt', 'asc')
      .limit(100)
      .skip(skip)
      .get()
      .catch(() => ({ data: [] }))
    const data = res.data || []
    rows.push(...data)
    if (data.length < 100) break
    skip += 100
  }

  const bl = await blacklistMap(rows.map(r => r.openid))

  // 按 sessionId 分组
  const groups = {}
  rows.forEach(r => {
    const b = bl[r.openid] || {}
    const item = {
      _id: r._id,
      openid: r.openid || '',
      name: r.name || '匿名顾客',
      phone: r.phone || '',
      partySize: r.partySize || 0,
      note: r.note || '',
      wechat: r.wechat || '',
      gender: r.gender || '',
      age: r.age || '',
      review: r.review || 'none',
      status: r.status || 'pending',
      isBlacklisted: !!b.isBlacklisted,
      blacklistReason: b.blacklistReason || ''
    }
    const sid = r.sessionId || 'unknown'
    if (!groups[sid]) groups[sid] = []
    groups[sid].push(item)
  })

  return ok({ groups })
}
