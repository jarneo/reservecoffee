// listProducts — 顾客端：列出某项目「在售」菜品（含图片临时 URL）
const { db, COL, ok, fail, cloud } = require('./lib')

async function resolveImages(list) {
  const ids = (list || []).map(p => p.image).filter(Boolean)
  let urlMap = {}
  if (ids.length) {
    try {
      const res = await cloud.getTempFileURL({ fileList: ids })
      ;(res.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[listProducts] getTempFileURL failed:', e.message) }
  }
  return (list || []).map(p => ({ ...p, imageUrl: urlMap[p.image] || '' }))
}

exports.main = async (event) => {
  const { projectId } = event
  if (!projectId) return fail('缺少 projectId')
  const proj = await db.collection(COL.projects).doc(projectId).get().catch(() => null)
  if (!proj || !proj.data || !proj.data.published) return fail('项目不可访问')

  const res = await db.collection(COL.products).where({ projectId, status: 'on' })
    .orderBy('sort', 'asc').get()
  const products = await resolveImages(res.data || [])
  return ok({ products })
}
