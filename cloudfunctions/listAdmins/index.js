// listAdmins — 管理员列表（owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可查看管理员')

  const res = await db.collection(COL.admins).orderBy('createdAt', 'asc').get()
  return ok({ list: res.data || [] })
}
