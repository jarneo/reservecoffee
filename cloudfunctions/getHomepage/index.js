// getHomepage — 顾客端首页数据：首页配置 + 已发布且未删除项目列表 + 在售店铺菜单
const { db, COL, ok, fail, wxCtx, cloud, _ } = require('./lib')

async function resolveImage(fileId) {
  if (!fileId) return ''
  try {
    const res = await cloud.getTempFileURL({ fileList: [fileId] })
    const f = (res.fileList || [])[0]
    return (f && f.fileID) ? f.tempFileURL : ''
  } catch (e) { console.warn('[getHomepage] resolveImage failed:', e.message); return '' }
}

// 批量解析菜品主图临时 URL
async function resolveProducts(list) {
  if (!list.length) return list
  const ids = list.map(p => p.image).filter(Boolean)
  let urlMap = {}
  if (ids.length) {
    try {
      const res = await cloud.getTempFileURL({ fileList: ids })
      ;(res.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[getHomepage] getTempFileURL failed:', e.message) }
  }
  return list.map(p => ({ ...p, imageUrl: urlMap[p.image] || '' }))
}

exports.main = async () => {
  const { OPENID } = wxCtx()
  // 首页文案（单文档 _id='homepage'）
  const hp = await db.collection(COL.homepage).doc('homepage').get().catch(() => ({ data: null }))
  const homepage = hp.data || { logo: '二曜路8号咖啡和清酒', tag: 'SLOW COFFEE · 预约制', heroImage: '', intro: '' }

  // 已发布且未删除的项目
  const proj = await db.collection(COL.projects).where({ published: true, deleted: _.neq(true) }).orderBy('createdAt', 'asc').get()
  const projects = (proj.data || []).map(p => ({
    _id: p._id,
    name: p.name,
    icon: p.icon,
    image: p.image,
    imageUrl: '',
    intro: p.intro,
    needReview: !!p.needReview
  }))

  // 解析首个可见项目的封面为临时 URL（顾客首页头图）
  if (projects.length && projects[0].image) {
    projects[0].imageUrl = await resolveImage(projects[0].image)
  }

  // 店铺菜单：在售菜品（按可见项目范围），含评价数
  let products = []
  const projectIds = projects.map(p => p._id)
  if (projectIds.length) {
    const pRes = await db.collection(COL.products)
      .where({ projectId: _.in(projectIds), status: 'on' })
      .orderBy('sort', 'asc').get()
    products = await resolveProducts(pRes.data || [])

    const productIds = products.map(p => p._id)
    if (productIds.length) {
      const rRes = await db.collection(COL.reviews).where({ productId: _.in(productIds), status: 'normal' }).get()
      const cnt = {}
      ;(rRes.data || []).forEach(r => { cnt[r.productId] = (cnt[r.productId] || 0) + 1 })
      products = products.map(p => ({
        _id: p._id, name: p.name, price: p.price, desc: p.desc,
        image: p.image, imageUrl: p.imageUrl, reviewCount: cnt[p._id] || 0
      }))
    } else {
      products = products.map(p => ({ ...p, reviewCount: 0 }))
    }
  }

  // 解析首页主图（店铺主图）为临时 URL，供顾客首页头图展示
  if (homepage.heroImage) {
    try { homepage.heroImageUrl = await resolveImage(homepage.heroImage) } catch (e) { homepage.heroImageUrl = '' }
  }
  console.log('[getHomepage] openid=', OPENID, 'projects=', projects.length, 'products=', products.length)
  return ok({ homepage, projects, products })
}
