// updateHomepage — 保存首页配置（仅 owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可配置首页')

  // 仅更新传入的字段，避免覆盖未提供的 logo/tag 等（封面页只传 heroImage/intro）
  const data = { updatedAt: Date.now() }
  if (event.logo !== undefined) data.logo = String(event.logo).slice(0, 30)
  if (event.tag !== undefined) data.tag = String(event.tag).slice(0, 40)
  if (event.heroImage !== undefined) data.heroImage = event.heroImage
  if (event.intro !== undefined) data.intro = String(event.intro).slice(0, 500)
  await db.collection(COL.homepage).doc('homepage').update({ data })
  return ok({ updated: true })
}
