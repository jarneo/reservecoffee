// publishProject — 发布/下架项目到首页（仅 owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可发布项目')

  const { projectId, published } = event
  if (!projectId) return fail('缺少 projectId')
  await db.collection(COL.projects).doc(projectId).update({
    data: { published: !!published, updatedAt: Date.now() }
  })
  return ok({ published: !!published })
}
