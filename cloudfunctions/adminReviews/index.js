// adminReviews — 管理端：按菜品查看评价（可切换菜品）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId, productId, reviewStatus } = event
  // projectId 可选：空 = 全部项目（跨项目查看所有菜品评价）
  const projFilter = projectId ? { projectId } : null

  const prodRes = await db.collection(COL.products).where(projFilter || {}).orderBy('sort', 'asc').get()
  const products = (prodRes.data || []).map(p => ({ _id: p._id, name: p.name }))

  // 待审核总数（用于 tab 角标），与菜品筛选无关
  let pendingCount = 0
  try {
    const pc = await db.collection(COL.reviews).where(Object.assign({ reviewStatus: 'pending' }, projFilter || {})).count()
    pendingCount = (pc && pc.total) || 0
  } catch (e) { /* count 不支持时忽略 */ }

  const where = Object.assign({}, projFilter || {})
  if (productId) where.productId = productId
  if (reviewStatus === 'pending') where.reviewStatus = 'pending'
  const revRes = await db.collection(COL.reviews).where(where).get()
  const reviews = (revRes.data || []).slice().sort((a, b) =>
    ((a.reviewStatus === 'pending' ? 0 : 1) - (b.reviewStatus === 'pending' ? 0 : 1)) ||
    ((b.top ? 1 : 0) - (a.top ? 1 : 0)) ||
    ((b.createdAt || 0) - (a.createdAt || 0))
  )
  const nameMap = {}
  products.forEach(p => { nameMap[p._id] = p.name })
  reviews.forEach(r => { r.productName = nameMap[r.productId] || '' })

  return ok({ reviews, products, pendingCount })
}
