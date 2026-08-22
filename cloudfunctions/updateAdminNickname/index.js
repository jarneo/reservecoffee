// updateAdminNickname — 超级管理员为管理员设置展示昵称（便于识别）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可设置昵称')

  const { openid, nickname } = event
  if (!openid) return fail('缺少 openid')
  const nick = String(nickname == null ? '' : nickname).trim().slice(0, 20)
  if (!nick) return fail('昵称不能为空')

  const exist = await db.collection(COL.admins).where({ openid }).get()
  if (!exist.data.length) return fail('管理员不存在')

  await db.collection(COL.admins).where({ openid }).update({ data: { nickname: nick } })
  return ok({ nickname: nick })
}
