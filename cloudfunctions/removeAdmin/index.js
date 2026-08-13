// removeAdmin — 移除管理员（owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可移除')

  const { adminId } = event
  if (!adminId) return fail('缺少 adminId')
  await db.collection(COL.admins).doc(adminId).remove()
  return ok({ removed: true })
}
