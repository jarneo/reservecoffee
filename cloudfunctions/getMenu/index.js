// getMenu — 公众号 / 分享专用：店铺菜单 + 顾客评价（公开只读，无需登录）
// 该页仅通过公众号菜单路径进入，不在小程序内导航出现。
const { db, COL, ok, fail, cloud, _ } = require('./lib')

async function resolveImages(list) {
  const ids = (list || []).map(p => p.image).filter(Boolean)
  let urlMap = {}
  if (ids.length) {
    try {
      const res = await cloud.getTempFileURL({ fileList: ids })
      ;(res.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[getMenu] getTempFileURL failed:', e.message) }
  }
  return (list || []).map(p => ({ ...p, imageUrl: urlMap[p.image] || '' }))
}

exports.main = async (event) => {
  const { projectId } = event || {}

  // 店铺信息（取自首页配置，缺失时使用兜底）
  let shop = { logo: '店铺菜单', tag: '', intro: '' }
  try {
    const hp = await db.collection(COL.homepage).doc('homepage').get()
    if (hp && hp.data) {
      shop = { logo: hp.data.logo || shop.logo, tag: hp.data.tag || '', intro: hp.data.intro || '' }
    }
  } catch (e) { /* 缺少首页配置时忽略，使用兜底 */ }

  // 确定可展示的项目范围（仅已发布）
  let projectIds = []
  if (projectId) {
    const proj = await db.collection(COL.projects).doc(projectId).get().catch(() => null)
    if (proj && proj.data && proj.data.published) projectIds = [projectId]
  } else {
    const pub = await db.collection(COL.projects).where({ published: true }).get()
    projectIds = (pub.data || []).map(p => p._id)
  }
  if (!projectIds.length) return ok({ shop, products: [], reviews: [] })

  // 在售菜品（按 sort 升序）
  const pRes = await db.collection(COL.products)
    .where({ projectId: _.in(projectIds), status: 'on' })
    .orderBy('sort', 'asc').get()
  const products = await resolveImages(pRes.data || [])

  // 可见评价（仅人工审核通过；置顶优先，再按时间倒序）
  const productIds = products.map(p => p._id)
  let flat = []
  if (productIds.length) {
    const rRes = await db.collection(COL.reviews)
      .where({ productId: _.in(productIds), reviewStatus: 'approved' })
      .get()
    flat = (rRes.data || []).slice().sort((a, b) =>
      ((b.top ? 1 : 0) - (a.top ? 1 : 0)) || ((b.createdAt || 0) - (a.createdAt || 0))
    )
  }

  // 解析评价头像 + 图片 fileID → 临时 URL
  const ids = [...new Set([
    ...flat.map(r => r.avatar).filter(Boolean),
    ...flat.flatMap(r => (r.images || [])).filter(Boolean)
  ])]
  let urlMap = {}
  if (ids.length) {
    try {
      const ares = await cloud.getTempFileURL({ fileList: ids })
      ;(ares.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[getMenu] media resolve failed:', e.message) }
  }
  const flatWithAvatar = flat.map(r => ({
    ...r,
    avatarUrl: urlMap[r.avatar] || '',
    imagesUrl: (r.images || []).map(id => urlMap[id] || '')
  }))

  // 关联菜品名称 + 回填到菜品对象
  const nameMap = {}
  products.forEach(p => { nameMap[p._id] = p.name })
  const flatWithName = flatWithAvatar.map(r => ({ ...r, productName: nameMap[r.productId] || '' }))
  const byProduct = {}
  flatWithName.forEach(r => { (byProduct[r.productId] = byProduct[r.productId] || []).push(r) })
  const productsWithReviews = products.map(p => ({ ...p, reviews: byProduct[p._id] || [] }))

  return ok({ shop, products: productsWithReviews, reviews: flatWithName })
}
