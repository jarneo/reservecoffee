// listAdmins — 管理员列表（owner）
// 含管理推送订阅状态（subscriptions / subscribedAt / lastErrorAt），
// 供管理台判断「谁的推送已失效，需要续订」。
const { db, COL, ok, fail, wxCtx, getRole, ADMIN_SUB_KEYS, normalizeAdminSubs } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可查看管理员')

  const res = await db.collection(COL.admins).orderBy('createdAt', 'asc').get()
  const list = (res.data || []).map(a => {
    const subs = normalizeAdminSubs(a.subscriptions)
    // hasInvalid：任一推送被标记失效（用于列表行/管理台高亮）
    const hasInvalid = ADMIN_SUB_KEYS.some(k => subs[k] === false)
    return {
      _id: a._id,
      openid: a.openid,
      role: a.role,
      note: a.note || '',
      nickname: a.nickname || '',
      createdAt: a.createdAt || 0,
      // 订阅状态（缺省全 true，见 normalizeAdminSubs 注释：存量管理员从未写过该字段）
      subscriptions: subs,
      hasInvalid,
      subscribedAt: a.subscribedAt || 0,
      lastErrorAt: a.lastErrorAt || 0,
      lastErrorKey: a.lastErrorKey || '',
      // 角色变更审计（由 updateAdminRole 写入）：用于「谁把谁提权了」可追溯
      roleChangedAt: a.roleChangedAt || 0,
      roleChangedFrom: a.roleChangedFrom || ''
    }
  })
  return ok({ list })
}
