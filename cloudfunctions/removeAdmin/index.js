// removeAdmin — 移除管理员（owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可移除')

  const { adminId } = event
  if (!adminId) return fail('缺少 adminId')

  // 取出要移除的管理员
  const target = await db.collection(COL.admins).doc(adminId).get()
  if (!target.data) return fail('管理员不存在')

  // 禁止删除最后一个超级管理员，避免权限失控（否则下一个打开者会被自动设为 owner）
  if (target.data.role === 'owner') {
    const owners = await db.collection(COL.admins).where({ role: 'owner' }).get()
    if (owners.data.length <= 1) return fail('至少保留一个超级管理员，无法移除')
  }

  await db.collection(COL.admins).doc(adminId).remove()
  return ok({ removed: true })
}
