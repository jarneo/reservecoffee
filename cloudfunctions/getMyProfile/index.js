// getMyProfile — 读取当前顾客的微信昵称/手机号/头像（按 openid）
const { db, COL, ok, fail, wxCtx } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('未登录')
  const r = await db.collection(COL.users).doc(OPENID).get().catch(() => ({ data: null }))
  const u = r.data
  if (!u) return ok({ profile: null, openid: OPENID })
  return ok({
    profile: {
      name: u.name || '',
      phone: u.phone || '',
      avatar: u.avatar || '',
      // 黑名单状态：顾客端据此在预约页提前阻断，避免用户填完表单提交后才被拒
      isBlacklisted: !!u.isBlacklisted,
      blacklistReason: u.blacklistReason || ''
    },
    openid: OPENID,
    mpOpenid: u.mpOpenid || ''   // 服务号授权状态（非空=已授权）
  })
}
