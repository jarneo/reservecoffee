// getProduct — 顾客端：单个菜品详情 + 评价列表（含图片/评分）
const { db, COL, ok, fail, cloud, thumb } = require('./lib')

async function resolveImage(fileId) {
  if (!fileId) return ''
  try {
    const res = await cloud.getTempFileURL({ fileList: [fileId] })
    const f = (res.fileList || [])[0]
    return (f && f.fileID) ? f.tempFileURL : ''
  } catch (e) { return '' }
}

exports.main = async (event) => {
  const { productId } = event
  if (!productId) return fail('缺少 productId')
  const pRes = await db.collection(COL.products).doc(productId).get().catch(() => null)
  const p = pRes && pRes.data
  if (!p) return fail('菜品不存在')

  const proj = await db.collection(COL.projects).doc(p.projectId).get().catch(() => null)
  if (!proj || !proj.data || !proj.data.published) return fail('项目不可访问')

  // 详情页主图全宽展示（750rpx），750x 足够
  const imageUrl = thumb(await resolveImage(p.image), 'cover')
  // 仅对外展示「人工审核通过」的评价
  const rev = await db.collection(COL.reviews).where({ productId, reviewStatus: 'approved' }).get()
  let reviews = (rev.data || []).slice().sort((a, b) =>
    ((b.top ? 1 : 0) - (a.top ? 1 : 0)) || ((b.createdAt || 0) - (a.createdAt || 0))
  )
  const count = reviews.length
  const avg = count ? Math.round(reviews.reduce((s, x) => s + (x.rating || 0), 0) / count * 10) / 10 : 0

  // 解析评价头像 + 图片 fileID → 临时 URL
  const ids = [...new Set([
    ...reviews.map(r => r.avatar).filter(Boolean),
    ...reviews.flatMap(r => (r.images || [])).filter(Boolean)
  ])]
  let urlMap = {}
  if (ids.length) {
    try {
      const ares = await cloud.getTempFileURL({ fileList: ids })
      ;(ares.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[getProduct] media resolve failed:', e.message) }
  }
  reviews = reviews.map(r => ({
    ...r,
    avatarUrl: thumb(urlMap[r.avatar] || '', 'avatar'),
    imagesUrl: (r.images || []).map(id => thumb(urlMap[id] || '', 'card'))
  }))

  const product = { ...p, imageUrl, rating: avg, ratingCount: count }
  return ok({ product, reviews })
}
