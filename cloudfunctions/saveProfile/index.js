// saveProfile — 写入/更新当前顾客的昵称/手机号/头像（按 openid，增量合并）
const { db, COL, ok, fail, wxCtx } = require('./lib')

exports.main = async (event) => {
  const ctx = wxCtx()
  const OPENID = ctx.OPENID
  if (!OPENID) return fail('未登录')

  const patch = { updatedAt: Date.now() }
  if (event.name !== undefined) patch.name = String(event.name).trim().slice(0, 30)

  if (event.phone !== undefined) {
    const phone = String(event.phone).trim()
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) return fail('手机号格式不正确')
    patch.phone = phone
  }
  if (event.avatar !== undefined) patch.avatar = String(event.avatar)
  // 关联服务号推送：存 unionid（小程序+服务号同开放平台后由微信返回；缺则跳过）
  if (ctx.UNIONID) patch.unionid = ctx.UNIONID

  const ex = await db.collection(COL.users).doc(OPENID).get().catch(() => null)
  if (ex && ex.data) {
    await db.collection(COL.users).doc(OPENID).update({ data: patch })
  } else {
    await db.collection(COL.users).doc(OPENID).set({ data: { openid: OPENID, ...patch } })
  }
  return ok({})
}
