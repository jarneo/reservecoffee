// adminReviews — 管理端：按菜品查看评价（可切换菜品）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId, productId } = event
  if (!projectId) return fail('缺少 projectId')

  const prodRes = await db.collection(COL.products).where({ projectId }).orderBy('sort', 'asc').get()
  const products = (prodRes.data || []).map(p => ({ _id: p._id, name: p.name }))

  const where = { projectId }
  if (productId) where.productId = productId
  const revRes = await db.collection(COL.reviews).where(where).get()
  const reviews = (revRes.data || []).slice().sort((a, b) =>
    ((b.top ? 1 : 0) - (a.top ? 1 : 0)) || ((b.createdAt || 0) - (a.createdAt || 0))
  )
  const nameMap = {}
  products.forEach(p => { nameMap[p._id] = p.name })
  reviews.forEach(r => { r.productName = nameMap[r.productId] || '' })

  return ok({ reviews, products })
}
