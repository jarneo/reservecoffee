// listCategories — 公开只读：列出全部菜单分类（按 sort 升序），供首页/菜单页/管理端下拉使用
const { db, COL, ok, fail } = require('./lib')

exports.main = async () => {
  const res = await db.collection(COL.categories).orderBy('sort', 'asc').get().catch(() => ({ data: [] }))
  return ok({ categories: res.data || [] })
}
