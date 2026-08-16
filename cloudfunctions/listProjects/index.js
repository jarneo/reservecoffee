// listProjects — 项目列表（owner/manager 均可；manager 不含敏感配置）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const res = await db.collection(COL.projects).orderBy('createdAt', 'asc').get()
  const list = (res.data || []).map(p => ({
    _id: p._id,
    name: p.name,
    icon: p.icon,
    published: !!p.published,
    needReview: !!p.needReview,
    paused: !!p.paused,
    deleted: !!p.deleted,
    openDays: p.openDays || []
  }))
  return ok({ list })
}
