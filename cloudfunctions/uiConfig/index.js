// uiConfig — 管理端「界面开关」读写（仅 owner）
//
// 目前只有一项：
//   pathBar —— 页面路径条。owner 登录时在页面末尾显示「当前页完整路径 + 复制」，
//              用于配公众号菜单 pagepath / 生成短链。关掉后不再渲染（顾客端本来就看不到）。
//
// 读：{ action:'get' }                → { pathBar: boolean }
// 写：{ action:'set', pathBar: bool } → { pathBar: boolean }
// 落库：config 集合 _id='ui'（文档不存在时按默认值 true）
const { db, ok, fail, wxCtx, getRole } = require('./lib')

const DEF = { pathBar: true }

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可操作')

  let cfg = Object.assign({}, DEF)
  try {
    const doc = await db.collection('config').doc('ui').get()
    if (doc && doc.data) cfg = Object.assign(cfg, doc.data)
  } catch (e) {
    // 文档不存在（首次）→ 用默认值
  }

  const action = (event && event.action) || 'get'
  if (action === 'set') {
    const next = Object.assign({}, cfg)
    delete next._id   // CloudBase 的 set/update 不允许 data 里带 _id
    if (typeof event.pathBar === 'boolean') next.pathBar = event.pathBar
    next.updatedAt = Date.now()
    try {
      await db.collection('config').doc('ui').set({ data: next })
    } catch (e) {
      return fail('保存失败：' + ((e && (e.errMsg || e.message)) || e))
    }
    return ok({ pathBar: next.pathBar !== false })
  }

  return ok({ pathBar: cfg.pathBar !== false })
}
