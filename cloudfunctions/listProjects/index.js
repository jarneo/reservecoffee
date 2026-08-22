// listProjects — 项目列表（owner/manager 均可；manager 不含敏感配置）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const res = await db.collection(COL.projects).orderBy('createdAt', 'asc').get()
  const list = (res.data || [])
    .filter(p => !p.deleted) // 软删除的项目不再出现在管理列表（删除后即消失，符合预期）
    .map(p => ({
      _id: p._id,
      name: p.name,
      icon: p.icon,
      published: !!p.published,
      needReview: !!p.needReview,
      paused: !!p.paused,
      deleted: !!p.deleted,
      maxParty: p.maxParty || 2,
      subscribeNotify: !!p.subscribeNotify,
      openDays: p.openDays || []
    }))
  return ok({ list })
}
