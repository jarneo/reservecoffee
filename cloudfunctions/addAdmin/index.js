// addAdmin — 授权管理员（owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可授权')

  const { openid, role: newRole, note } = event
  if (!openid) return fail('缺少 openid')
  if (!['owner', 'manager'].includes(newRole)) return fail('角色非法')

  const exist = await db.collection(COL.admins).where({ openid }).get()
  if (exist.data.length) return fail('该用户已是管理员')

  const add = await db.collection(COL.admins).add({
    data: { openid, role: newRole, note: note || '', inviterOpenid: OPENID, createdAt: Date.now() }
  })
  return ok({ id: add._id })
}
