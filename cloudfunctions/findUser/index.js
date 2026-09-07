// findUser — 按昵称/手机号查找用户（owner，用于加入黑名单/写备注时定位 openid）
const { db, _, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (!role || role.role !== 'owner') return fail('无权限')

  const q = (event && event.q || '').trim()
  if (!q) return fail('请输入昵称或手机号')

  // 转义正则特殊字符，做大小写不敏感子串匹配
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const like = db.RegExp({ regexp: escaped, options: 'i' })

  const res = await db.collection(COL.users)
    .where(_.or([{ name: like }, { phone: like }]))
    .limit(6)
    .get()
    .catch(() => ({ data: [] }))

  const list = (res.data || []).map(u => ({
    openid: u._id,
    name: u.name || '',
    phone: u.phone || '',
    isBlacklisted: !!u.isBlacklisted
  }))
  return ok({ list })
}
