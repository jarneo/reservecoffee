// addAdmin — 授权管理员（owner）
const { db, COL, ok, fail, wxCtx, getRole, normalizeAdminSubs, ADMIN_SUB_KEYS } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可授权')

  const { openid, role: newRole, note } = event
  if (!openid) return fail('缺少 openid')
  if (!['owner', 'manager'].includes(newRole)) return fail('角色非法')

  const exist = await db.collection(COL.admins).where({ openid }).get()
  if (exist.data.length) return fail('该用户已是管理员')

  const add = await db.collection(COL.admins).add({
    data: {
      openid,
      role: newRole,
      note: note || '',
      inviterOpenid: OPENID,
      createdAt: Date.now(),
      // 初始化管理推送订阅状态为「全 true」（= 尚未授权但按缺省开处理）。
      // ⚠️ 显式写入而非留空：留空也能被 normalizeAdminSubs 当全 true，但显式写更便于
      //    后续排查「是否真的续订过」，也与 notifyAdmins 的点路径回写形状保持一致。
      subscriptions: normalizeAdminSubs({}),
      subscribedAt: 0
    }
  })
  return ok({ id: add._id, subKeys: ADMIN_SUB_KEYS })
}
