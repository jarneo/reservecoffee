// listSessionReservations — 查看某场次预约人（含联系方式 + 黑名单标记，owner/manager）
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

  const { projectId, date, sessionId } = event
  if (!sessionId) return fail('缺少 sessionId')

  // 仅显示有效预约：未取消 + 未审核拒绝
  const where = {
    sessionId,
    status: _.in(['pending', 'confirmed']),
    review: _.neq('rejected')
  }
  if (projectId) where.projectId = projectId
  if (date) where.date = date

  const res = await db.collection(COL.reservations).where(where).orderBy('createdAt', 'asc').limit(100).get()
  const rows = res.data || []
  const bl = await blacklistMap(rows.map(r => r.openid))

  const list = rows.map(r => {
    const b = bl[r.openid] || {}
    return {
      _id: r._id,
      openid: r.openid || '',
      name: r.name || '匿名顾客',
      phone: r.phone || '',
      partySize: r.partySize || 0,
      note: r.note || '',
      review: r.review || 'none',
      status: r.status || 'pending',
      isBlacklisted: !!b.isBlacklisted,
      blacklistReason: b.blacklistReason || ''
    }
  })
  return ok({ list })
}
