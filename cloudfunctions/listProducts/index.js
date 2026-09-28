// listProducts — 顾客端：列出某项目「在售」菜品（含图片临时 URL）
const { db, COL, ok, fail, cloud, thumb, _ } = require('./lib')

async function resolveImages(list) {
  const ids = (list || []).map(p => p.image).filter(Boolean)
  let urlMap = {}
  if (ids.length) {
    try {
      const res = await cloud.getTempFileURL({ fileList: ids })
      ;(res.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[listProducts] getTempFileURL failed:', e.message) }
  }
  // 菜品卡片图：每栏约 170px 宽，400x 足够（原图 96~186KB → 约 10KB）
  return (list || []).map(p => ({ ...p, imageUrl: thumb(urlMap[p.image] || '', 'card') }))
}

exports.main = async (event) => {
  const { projectId, categoryId } = event
  // projectId 可选：缺省时取全部「已发布」项目（首页分类 tab 跨项目全量）；指定时校验项目可见性
  let projectIds = []
  if (projectId) {
    const proj = await db.collection(COL.projects).doc(projectId).get().catch(() => null)
    if (!proj || !proj.data || !proj.data.published) return fail('项目不可访问')
    projectIds = [projectId]
  } else {
    const proj = await db.collection(COL.projects).where({ published: true, deleted: _.neq(true) }).get()
    projectIds = (proj.data || []).map(p => p._id)
  }
  if (!projectIds.length) return ok({ products: [] })

  const where = { projectId: _.in(projectIds), status: 'on' }
  if (categoryId) where.categoryId = categoryId   // 分类筛选（首页分类 tab / 菜单页分类 tab）
  const res = await db.collection(COL.products).where(where).orderBy('sort', 'asc').get()
  const products = await resolveImages(res.data || [])
  return ok({ products })
}
