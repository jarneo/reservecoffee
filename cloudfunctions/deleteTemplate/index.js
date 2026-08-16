// deleteTemplate — 删除场次模版（owner）
const { db, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可管理模版')
  if (!event._id) return fail('缺少 _id')
  await db.collection('templates').doc(event._id).remove()
  return ok({ deleted: true })
}
