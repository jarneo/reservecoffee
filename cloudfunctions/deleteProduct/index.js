// deleteProduct — 管理端：删除菜品（同步清理云存储图片 + 关联评价，避免孤儿文件）
const { db, COL, ok, fail, wxCtx, getRole, cloud } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { productId } = event
  if (!productId) return fail('缺少 productId')
  const pRes = await db.collection(COL.products).doc(productId).get().catch(() => null)
  const p = pRes && pRes.data
  if (!p) return fail('菜品不存在')

  if (p.image) {
    try { await cloud.deleteFile({ fileList: [p.image] }) }
    catch (e) { console.warn('[deleteProduct] deleteFile failed:', e.message) }
  }
  await db.collection(COL.reviews).where({ productId }).remove()
  await db.collection(COL.products).doc(productId).remove()
  return ok({ deleted: true })
}
