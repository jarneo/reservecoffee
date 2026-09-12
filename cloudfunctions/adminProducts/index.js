// adminProducts — 管理端：列出某项目全部菜品（含下架，含图片临时 URL）
const { db, COL, ok, fail, cloud, wxCtx, getRole } = require('./lib')

async function resolveImages(list) {
  const ids = (list || []).map(p => p.image).filter(Boolean)
  let urlMap = {}
  if (ids.length) {
    try {
      const res = await cloud.getTempFileURL({ fileList: ids })
      ;(res.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[adminProducts] getTempFileURL failed:', e.message) }
  }
  return (list || []).map(p => ({ ...p, imageUrl: urlMap[p.image] || '' }))
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId } = event
  // projectId 可选：空 = 全部项目（跨项目列出所有菜品）
  const res = await db.collection(COL.products).where(projectId ? { projectId } : {}).orderBy('sort', 'asc').get()
  const products = await resolveImages(res.data || [])
  return ok({ products })
}
