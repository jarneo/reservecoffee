// adminUpdateCustomer — 管理员修正顾客资料 / 备注 / 标签 / 黑名单（仅 owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (!role || role.role !== 'owner') return fail('仅超级管理员可操作')

  const target = (event && event.openid) || ''
  if (!target) return fail('缺少 openid')

  const patch = { updatedAt: Date.now() }

  if (event.name !== undefined) patch.name = String(event.name).trim().slice(0, 30)
  if (event.phone !== undefined) {
    const phone = String(event.phone).trim()
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) return fail('手机号格式不正确')
    patch.phone = phone
  }
  if (event.remark !== undefined) patch.remark = String(event.remark).slice(0, 200)
  if (event.tags !== undefined) {
    // 手动标签：去重、去空、限长
    const arr = Array.isArray(event.tags) ? event.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 20) : []
    patch.tags = Array.from(new Set(arr))
  }
  if (event.blacklisted !== undefined) patch.isBlacklisted = !!event.blacklisted
  if (event.blacklistReason !== undefined) patch.blacklistReason = String(event.blacklistReason).slice(0, 200)

  const ex = await db.collection(COL.users).doc(target).get().catch(() => null)
  if (ex && ex.data) {
    await db.collection(COL.users).doc(target).update({ data: patch })
  } else {
    await db.collection(COL.users).doc(target).set({ data: { openid: target, ...patch } })
  }
  return ok({})
}
