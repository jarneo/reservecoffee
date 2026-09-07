// markLaunch — 首启采集（仅首次写入 firstLaunchAt / firstSource）
// app.js onLaunch 调 wx.getEnterOptionsSync() 取 scene，传入 event.scene
const { db, COL, ok, fail, wxCtx, srcLabel } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('未登录')

  const ex = await db.collection(COL.users).doc(OPENID).get().catch(() => null)
  const exists = ex && ex.data

  // 已采集过（最早来源/时间不可覆盖）则不动
  if (exists && (exists.data.firstLaunchAt || exists.data.firstSource != null)) {
    return ok({ updated: false })
  }

  const scene = event && event.scene
  const patch = { firstLaunchAt: Date.now(), firstSource: scene || '' }
  if (exists) {
    await db.collection(COL.users).doc(OPENID).update({ data: patch })
  } else {
    await db.collection(COL.users).doc(OPENID).set({ data: { openid: OPENID, ...patch } })
  }
  return ok({ updated: true, source: srcLabel(scene) })
}
