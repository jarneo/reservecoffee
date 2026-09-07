// getBlacklist — 黑名单列表（仅 owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (!role || role.role !== 'owner') return fail('无权限')

  const res = await db.collection(COL.users)
    .where({ isBlacklisted: true })
    .orderBy('updatedAt', 'desc')
    .limit(200)
    .get()
    .catch(() => ({ data: [] }))

  const list = (res.data || []).map(u => ({
    openid: u._id,
    name: u.name || '',
    phone: u.phone || '',
    reason: u.blacklistReason || '',
    updatedAt: u.updatedAt || 0
  }))
  return ok({ list })
}
