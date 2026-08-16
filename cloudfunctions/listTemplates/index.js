// listTemplates — 列出全部场次模版（owner）
const { db, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可管理模版')
  try {
    await db.createCollection('templates').catch(() => {})
    const res = await db.collection('templates').orderBy('updatedAt', 'desc').get()
    return ok({ list: res.data || [] })
  } catch (e) {
    if (/not exist|does not exist|不存在/.test(e.message || '')) return ok({ list: [] })
    return fail(e.message || '读取失败')
  }
}
