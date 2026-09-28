// saveCategory — 管理端：新建 / 更新菜单分类（owner / manager）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { categoryId, name, sort, icon } = event
  if (!name || !name.trim()) return fail('请填写类目名称')

  const patch = {
    name: String(name).trim().slice(0, 40),
    sort: Number.isFinite(Number(sort)) ? Number(sort) : 0,
    icon: (typeof icon === 'string' && icon) ? icon.slice(0, 200) : ''
  }

  if (categoryId) {
    await db.collection(COL.categories).doc(categoryId).update({ data: patch })
    return ok({ id: categoryId, updated: true })
  }
  const add = await db.collection(COL.categories).add({
    data: Object.assign({ createdAt: Date.now() }, patch)
  })
  return ok({ id: add._id, created: true })
}
