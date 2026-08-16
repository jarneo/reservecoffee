// saveProduct — 管理端：新建 / 更新菜品（图片由客户端先上传，仅存 fileId）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId, productId, name, image, price, desc, status, sort } = event
  if (!projectId) return fail('缺少 projectId')
  if (!name || !name.trim()) return fail('请填写菜品名称')
  if (!image) return fail('请上传菜品图片')
  const p = Number(price)
  if (!(p >= 0)) return fail('价格无效')

  const patch = {
    name: String(name).trim().slice(0, 40),
    image: String(image).slice(0, 200),
    price: p,
    desc: String(desc || '').slice(0, 300),
    status: status === 'off' ? 'off' : 'on',
    sort: Number.isFinite(Number(sort)) ? Number(sort) : 0
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
