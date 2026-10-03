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

// ⚠️ type 白名单：新增类型必须同时更新 getAnalytics 的聚合口径，否则该类型只入库不参与统计。
//    share_timeline / open_from_share 用于区分「从分享卡片进入」；spm_enter 用于单页模式（scene 1154）排查。
const TYPES = ['visit', 'view_project', 'click_book', 'share_timeline', 'open_from_share', 'spm_enter']

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
        // scene：入口场景值（1154=朋友圈单页模式 / 1007-1008=聊天分享 / 1107=订阅消息…）
        // 此前完全没记，导致「用户从哪来」这个问题无法回答。
        scene: Number(event && event.scene) || 0,
        // route：来源页面路由，便于定位是哪条分享链路
        route: String((event && event.route) || '').slice(0, 200),
        createdAt: Date.now()
      }
    })
    return ok({ tracked: true })
  } catch (e) {
    // 埋点绝不能影响业务：写失败也返回成功态（tracked:false 便于排查），避免前端报警
    // ⚠️ 这里**必须 console.warn**：原先完全静默，导致「集合被删/权限异常」时
    //    UV 恒为 0 却毫无察觉（踩坑 2026-09-06）。前端仍拿成功态，不会被打扰。
    console.warn('[trackEvent] write failed (ignored):', (e && e.message) || e)
    return ok({ tracked: false, msg: (e && e.message) || '写入失败' })
  }
}
