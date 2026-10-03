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
  if (event.iconFileId !== undefined) patch.iconFileId = event.iconFileId
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
  if (event.showSeatInfo !== undefined) patch.showSeatInfo = !!event.showSeatInfo
  // 预约成功结果页的默认菜单分类（2026-10 新增）：存 menuCategories 的 _id，空串 = 全部。
  // ⚠️ 分类是**全局跨项目**集合（见 _lib 关于 COL.categories 的注释），
  //    但不同项目热销分类不同（咖啡 vs 清酒）→ 必须按项目配置。
  // 分类被 deleteCategory 删除后这里会变成悬空引用，结果页读到时会校验并回退「全部」。
  if (event.resultCategoryId !== undefined) {
    patch.resultCategoryId = typeof event.resultCategoryId === 'string' ? event.resultCategoryId.slice(0, 64) : ''
  }
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
  // 关联项目（一对多）：字符串数组、去重、排除自引用、上限 50；无效/已删目标在 getProject 展示时自动跳过
  if (event.relatedProjectIds !== undefined) {
    if (!Array.isArray(event.relatedProjectIds)) return fail('relatedProjectIds 须为数组')
    patch.relatedProjectIds = Array.from(
      new Set(event.relatedProjectIds.map(x => String(x).trim()).filter(Boolean))
    )
      .filter(id => id !== projectId)
      .slice(0, 50)
  }
  // 通知管理员分配（项目维度）：'all' = 全员；或 openid 字符串数组（指定接收人）。
  // ⚠️ 非法值（非 all/非数组/空数组）一律拒绝，避免误写成「无人接收」导致静默丢单。缺省不传则不改。
  if (event.notifyAdmins !== undefined) {
    if (event.notifyAdmins === 'all') {
      patch.notifyAdmins = 'all'
    } else if (Array.isArray(event.notifyAdmins)) {
      const list = Array.from(new Set(event.notifyAdmins.map(x => String(x).trim()).filter(Boolean)))
      if (!list.length) return fail('notifyAdmins 数组不能为空（如需全员请传 "all"）')
      patch.notifyAdmins = list
    } else {
      return fail('notifyAdmins 须为 "all" 或 openid 数组')
    }
  }
  patch.updatedAt = Date.now()

  await db.collection(COL.projects).doc(projectId).update({ data: patch })
  return ok({ updated: true })
}
