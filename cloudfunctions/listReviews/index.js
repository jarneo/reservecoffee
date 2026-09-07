// listReviews — 列出待审核预约（owner/manager），供审核页使用
// 附带 isBlacklisted：待审预约若在加入黑名单之前提交，审核页须标红提示管理员。
const { db, _, COL, ok, fail, wxCtx, getRole } = require('./lib')

// 批量取 users 的黑名单状态；openid 分片（CloudBase 单批上限 100）
async function blacklistMap(openids) {
  const map = {}
  const ids = [...new Set(openids.filter(Boolean))]
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

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('仅管理员可审核')

  const res = await db.collection(COL.reservations)
    .where({ review: 'pending', status: 'pending' })
    .orderBy('createdAt', 'asc').limit(200).get()

  const rows = res.data || []
  const ids = [...new Set(rows.map(r => r.projectId))]
  const projs = await db.collection(COL.projects).where({ _id: db.command.in(ids) }).get()
  const nm = {}
  projs.data.forEach(p => { nm[p._id] = p.name })

  const bl = await blacklistMap(rows.map(r => r.openid))

  const list = rows.map(r => {
    const b = bl[r.openid] || {}
    return {
      _id: r._id, openid: r.openid || '', name: r.name, phone: r.phone, partySize: r.partySize,
      projectName: nm[r.projectId] || '', date: r.date,
      time: `${r.sessionStart || ''}-${r.sessionEnd || ''}`, note: r.note || '',
      isBlacklisted: !!b.isBlacklisted, blacklistReason: b.blacklistReason || ''
    }
  })
  return ok({ list })
}
