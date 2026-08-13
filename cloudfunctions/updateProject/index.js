// updateProject — 更新项目配置（仅 owner；含 advanceDays 校验 1–30）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可修改项目')

  const { projectId } = event
  if (!projectId) return fail('缺少 projectId')

  const patch = {}
  if (event.name !== undefined) patch.name = String(event.name).slice(0, 30)
  if (event.icon !== undefined) patch.icon = event.icon
  if (event.image !== undefined) patch.image = event.image
  if (event.intro !== undefined) patch.intro = String(event.intro).slice(0, 300)
  if (event.needReview !== undefined) patch.needReview = !!event.needReview
  if (event.paused !== undefined) patch.paused = !!event.paused
  if (event.dailyLimit !== undefined) patch.dailyLimit = Math.max(1, Number(event.dailyLimit) || 1)
  if (event.useSlotTemplate !== undefined) patch.useSlotTemplate = !!event.useSlotTemplate
  if (event.slotTemplate !== undefined) patch.slotTemplate = Array.isArray(event.slotTemplate) ? event.slotTemplate.slice(0, 20) : []
  if (event.advanceDays !== undefined) {
    const adv = Number(event.advanceDays)
    if (!(adv >= 1 && adv <= 30)) return fail('提前天数须在 1–30 之间')
    patch.advanceDays = adv
  }
  patch.updatedAt = Date.now()

  await db.collection(COL.projects).doc(projectId).update({ data: patch })
  return ok({ updated: true })
}
