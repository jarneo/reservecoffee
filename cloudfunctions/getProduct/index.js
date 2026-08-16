// getProduct — 顾客端：单个菜品详情 + 评价列表（含图片/评分）
const { db, COL, ok, fail, cloud } = require('./lib')

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

  const imageUrl = await resolveImage(p.image)
  const rev = await db.collection(COL.reviews).where({ productId, status: 'normal' }).get()
  const reviews = (rev.data || []).slice().sort((a, b) =>
    ((b.top ? 1 : 0) - (a.top ? 1 : 0)) || ((b.createdAt || 0) - (a.createdAt || 0))
  )
  const count = reviews.length
  const avg = count ? Math.round(reviews.reduce((s, x) => s + (x.rating || 0), 0) / count * 10) / 10 : 0

  const product = { ...p, imageUrl, rating: avg, ratingCount: count }
  return ok({ product, reviews })
}
