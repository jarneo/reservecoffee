// deleteProjectFile — 删除云存储中的图片文件（避免孤儿文件）
// 入参：{ fileIds: ['cloud://...', ...] }
// 权限：owner（与 projectConfig 一致）；manager 暂不开通图片删除
const { db, COL, ok, fail, wxCtx, getRole, cloud } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可删除文件')

  const ids = Array.isArray(event.fileIds) ? event.fileIds : []
  const fileList = ids.map(String).filter(Boolean).slice(0, 20)
  if (!fileList.length) return fail('缺少 fileIds')

  try {
    const res = await cloud.deleteFile({ fileList })
    return ok({ deleted: (res.fileList || []).filter(f => f.status === 0).length, detail: res.fileList || [] })
  } catch (e) {
    return fail('删除失败：' + (e.message || e))
  }
}
