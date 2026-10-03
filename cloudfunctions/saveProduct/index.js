// saveProduct — 管理端：新建 / 更新菜品（图片由客户端先上传，仅存 fileId）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId, productId, name, image, price, desc, status, sort, categoryId, ratio } = event
  if (!projectId) return fail('缺少 projectId')
  if (!name || !name.trim()) return fail('请填写菜品名称')
  if (!image) return fail('请上传菜品图片')
  const p = Number(price)
  if (!(p >= 0)) return fail('价格无效')

  // 分类：空值 / 非字符串 → 落空串（未归类）；合法 → 截断 40 字
  const cat = (typeof categoryId === 'string' && categoryId) ? categoryId.slice(0, 40) : ''

  // 图片宽高比 h/w：首页瀑布流用它估算卡片高度以对齐两列底边。
  // 合法区间 (0.2, 5]：越界/非数/缺省一律落 0，前端 masonry 会对 0 回退到默认 1.30。
  // ⚠️ 存量菜品没有该字段（0），属正常：引导店主重传一次图片即补齐。
  const ratioNum = Number(ratio)
  const ratioOk = isFinite(ratioNum) && ratioNum > 0.2 && ratioNum <= 5

  const patch = {
    name: String(name).trim().slice(0, 40),
    image: String(image).slice(0, 200),
    price: p,
    desc: String(desc || '').slice(0, 300),
    status: status === 'off' ? 'off' : 'on',
    sort: Number.isFinite(Number(sort)) ? Number(sort) : 0,
    categoryId: cat,
    ratio: ratioOk ? Math.round(ratioNum * 1000) / 1000 : 0
  }

  if (productId) {
    await db.collection(COL.products).doc(productId).update({ data: patch })
    return ok({ id: productId, updated: true })
  }
  const add = await db.collection(COL.products).add({
    data: Object.assign({ projectId, rating: 0, ratingCount: 0, createdAt: Date.now() }, patch)
  })
  return ok({ id: add._id, created: true })
}
