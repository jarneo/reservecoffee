// addReview — 顾客端：发表评价（评分 + 文字）
const { db, COL, ok, fail, wxCtx } = require('./lib')

async function recompute(db, productId) {
  const r = await db.collection(COL.reviews).where({ productId, status: 'normal' }).get()
  const list = r.data || []
  const count = list.length
  const avg = count ? Math.round(list.reduce((s, x) => s + (x.rating || 0), 0) / count * 10) / 10 : 0
  await db.collection(COL.products).doc(productId).update({ data: { rating: avg, ratingCount: count } }).catch(() => {})
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('无法识别身份')

  const { productId, rating, text, name, avatar, anonymous } = event
  if (!productId) return fail('缺少 productId')
  const r = Number(rating)
  if (!(r >= 1 && r <= 5)) return fail('请给出 1–5 星评分')

  const pRes = await db.collection(COL.products).doc(productId).get().catch(() => null)
  const p = pRes && pRes.data
  if (!p) return fail('菜品不存在')
  const proj = await db.collection(COL.projects).doc(p.projectId).get().catch(() => null)
  if (!proj || !proj.data || !proj.data.published) return fail('项目不可访问')

  const anon = !!anonymous
  const review = {
    projectId: p.projectId,
    productId,
    openid: OPENID,
    name: anon ? '匿名顾客' : ((name && name.trim()) || '匿名顾客'),
    avatar: anon ? '' : String(avatar || '').trim(),
    anonymous: anon,
    rating: r,
    text: String(text || '').slice(0, 300),
    status: 'normal',
    top: false,
    createdAt: Date.now()
  }
  const add = await db.collection(COL.reviews).add({ data: review })
  await recompute(db, productId)
  return ok({ id: add._id, created: true })
}
