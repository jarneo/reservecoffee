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
  if (event.maxParty !== undefined) patch.maxParty = Math.max(1, Math.min(20, Number(event.maxParty) || 2))
  if (event.subscribeNotify !== undefined) patch.subscribeNotify = !!event.subscribeNotify
  // 服务号通知总开关（项目级）：此前漏写导致「开启后保存仍显示未开启」
  if (event.mpNotify !== undefined) patch.mpNotify = !!event.mpNotify
  if (event.useSlotTemplate !== undefined) patch.useSlotTemplate = !!event.useSlotTemplate
  if (event.slotTemplate !== undefined) patch.slotTemplate = Array.isArray(event.slotTemplate) ? event.slotTemplate.slice(0, 20) : []
  // 介绍图片（图集）：整组替换，支持 上传/替换/删除/排序/说明
  if (event.introImages !== undefined) {
    if (!Array.isArray(event.introImages)) return fail('introImages 须为数组')
    if (event.introImages.length > 9) return fail('介绍图片最多 9 张')
    patch.introImages = event.introImages.slice(0, 9).map((it, i) => ({
      fileId: String(it.fileId || '').slice(0, 200),
      caption: String(it.caption || '').slice(0, 120),
      sort: Number.isFinite(Number(it.sort)) ? Number(it.sort) : i,
      width: Number(it.width) || 0,
      height: Number(it.height) || 0
    }))
  }
  if (event.advanceDays !== undefined) {
    const adv = Number(event.advanceDays)
    if (!(adv >= 1 && adv <= 30)) return fail('提前天数须在 1–30 之间')
    patch.advanceDays = adv
  }
  // 短信通知：每项目独立开关
  if (event.smsEnabled !== undefined) patch.smsEnabled = !!event.smsEnabled
  // 软删除（标记后可恢复，不影响历史预约）
  if (event.deleted !== undefined) patch.deleted = !!event.deleted
  // 预约截止规则：{ mode:'before'|'after', minutes }（场次开始前/开始后 N 分钟）
  if (event.cutoff !== undefined) {
    if (!event.cutoff || typeof event.cutoff !== 'object') return fail('cutoff 格式错误')
    const mode = ['before', 'after'].includes(event.cutoff.mode) ? event.cutoff.mode : 'before'
    const minutes = Math.min(1440, Math.max(1, Number(event.cutoff.minutes) || 30))
    patch.cutoff = { mode, minutes }
  }
  // 提交预约信息收集字段（白名单键）
  if (event.fields !== undefined) {
    patch.fields = Array.isArray(event.fields)
      ? event.fields.filter(k => typeof k === 'string').slice(0, 20)
      : []
  }
  patch.updatedAt = Date.now()

  await db.collection(COL.projects).doc(projectId).update({ data: patch })
  return ok({ updated: true })
}
