// deleteCategory — 管理端：删除菜单分类（仅 owner）。删除前校验引用数，防止孤儿菜品。
const { db, COL, ok, fail, wxCtx, getRole, _ } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅店主可删除类目')

  const { categoryId } = event
  if (!categoryId) return fail('缺少 categoryId')

  // 统计引用数：该类目下仍有菜品 → 拦截，避免菜品变成「只在全部可见」的孤儿
  const cntRes = await db.collection(COL.products).where({ categoryId }).count().catch(() => ({ total: 0 }))
  const cnt = (cntRes && cntRes.total) || 0
  if (cnt > 0) return fail(`该类目下还有 ${cnt} 道菜品，请先迁移或删除后再删除类目`)

  await db.collection(COL.categories).doc(categoryId).remove()
  return ok({ id: categoryId, deleted: true })
}
