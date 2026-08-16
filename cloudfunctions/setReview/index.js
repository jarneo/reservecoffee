// setReview — 管理端：置顶 / 隐藏 / 删除 单条评价
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

async function recompute(db, productId) {
  const r = await db.collection(COL.reviews).where({ productId, status: 'normal' }).get()
  const list = r.data || []
  const count = list.length
  const avg = count ? Math.round(list.reduce((s, x) => s + (x.rating || 0), 0) / count * 10) / 10 : 0
  await db.collection(COL.products).doc(productId).update({ data: { rating: avg, ratingCount: count } }).catch(() => {})
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { reviewId, action, value } = event
  if (!reviewId) return fail('缺少 reviewId')
  const rRes = await db.collection(COL.reviews).doc(reviewId).get().catch(() => null)
  const r = rRes && rRes.data
  if (!r) return fail('评论不存在')
  const productId = r.productId

  if (action === 'top') {
    await db.collection(COL.reviews).doc(reviewId).update({ data: { top: !!value } })
  } else if (action === 'hide') {
    const status = (value === undefined)
      ? (r.status === 'normal' ? 'hidden' : 'normal')
      : (value ? 'hidden' : 'normal')
    await db.collection(COL.reviews).doc(reviewId).update({ data: { status } })
    await recompute(db, productId)
  } else if (action === 'delete') {
    await db.collection(COL.reviews).doc(reviewId).remove()
    await recompute(db, productId)
  } else {
    return fail('未知操作')
  }
  return ok({ ok: true })
}
