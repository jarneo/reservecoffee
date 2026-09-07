// trackEvent — 前端埋点上报（写入 events 集合）
// type ∈ visit（访问小程序）/ view_project（查看项目详情）/ click_book（点击预约）
// 免鉴权：任何已登录用户均可上报；前端一律 fire-and-forget（.catch 静默）。
// ⚠️ 与 getAnalytics 的约定：createdAt 存毫秒时间戳 Date.now()，
//    周期过滤与 Asia/Shanghai 时区归一律在 getAnalytics 内统一处理，此处不做本地时区加工。
// ⚠️ events 集合本环境不会随 .add() 自动创建（实测 .add() 到不存在的集合会抛
//    "Db or Table not exist" 且被下方 catch 静默吞掉 → 集合永远建不起来 → UV 恒为 0 且无报错）。
//    已在云端用 writeNoSqlDatabaseStructure.createCollection 显式建好 events（2026-09-06），
//    此后真实访问即可累积；如集合被误删需重建。
const { db, ok, fail, wxCtx } = require('./lib')

const TYPES = ['visit', 'view_project', 'click_book']

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('未登录')
  const type = (event && event.type) || ''
  if (TYPES.indexOf(type) < 0) return fail('未知事件类型: ' + type)

  try {
    await db.collection('events').add({
      data: {
        openid: OPENID,
        type,
        projectId: (event && event.projectId) || '',
        createdAt: Date.now()
      }
    })
    return ok({ tracked: true })
  } catch (e) {
    // 埋点绝不能影响业务：写失败也返回成功态（tracked:false 便于排查），避免前端报警
    return ok({ tracked: false, msg: (e && e.message) || '写入失败' })
  }
}
