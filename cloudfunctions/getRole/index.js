// getRole — 返回当前微信用户的管理角色（无则 none）
const { ok, wxCtx, getRole, ensureOwner } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  if (!OPENID) return ok({ role: 'none', openid: '' })
  // 首个进入者自动成为店主
  await ensureOwner(OPENID)
  const role = await getRole(OPENID)
  return ok({ role: role.role, openid: OPENID, note: role.note || '' })
}
