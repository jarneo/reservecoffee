// mpAuth — 服务号网页授权回调：用 OAuth code 换「服务号 openid」，写入 users.mpOpenid
// 调用方式：小程序端授权页 snsapi_base 拿 code → 跳回 mine 页 → mine 调 call('mpAuth',{code})
//   （Event 调用；code 必填，openid 优先取云函数调用上下文 OPENID，event.openid 仅兜底）
// 说明：
//   - AppSecret 仅从环境变量 MP_APP_SECRET 读取（云端托管，不落代码、不出网到前端）
//   - 服务号 AppID 从环境变量 MP_APP_ID 读取（缺省 wx4d8d957ee8af6073）
//   - unionid 兜底：同一 unionid 下任意一端拿到服务号 openid，都同步到该 unionid 关联的用户文档
//   - 注意：服务号模板消息(templateMessage.send)要求接收人是服务号粉丝，未关注会返回 43004。
//     授权(网页 OAuth)只拿 openid，不保证已关注；是否关注由用户行为决定，代码无法在此校验。
const { cloud, db, COL, ok, wxCtx } = require('./lib')

// 简单 HTTPS GET（云函数 Node 18 内置 fetch）
async function _httpGet(url) {
  const resp = await fetch(url)
  const text = await resp.text()
  try { return JSON.parse(text) } catch (e) { return { errcode: -1, errmsg: text } }
}

exports.main = async (event) => {
  const code = event && event.code
  if (!code) return ok({ ok: false, msg: '缺少 code（授权未成功）' })

  // 绑定主键：优先取云函数调用上下文的「小程序 openid」（从小程序 call 调用时自动带）；
  // 前端传入的 event.openid 仅作兜底，避免 OAuth 重定向后参数传递丢失导致绑定失败。
  const ctx = wxCtx() || {}
  const openid = (ctx.OPENID || (event && (event.openid || event.state)) || '').trim()
  if (!openid) return ok({ ok: false, msg: '无法识别小程序身份，请在小程序内操作' })

  const appid = process.env.MP_APP_ID || 'wx4d8d957ee8af6073'
  const secret = process.env.MP_APP_SECRET || ''
  if (!secret) {
    return ok({ ok: false, msg: '服务端未配置服务号 AppSecret（环境变量 MP_APP_SECRET）' })
  }

  // 用 code 换服务号 access_token + openid
  let body
  try {
    const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appid}&secret=${secret}&code=${code}&grant_type=authorization_code`
    body = await _httpGet(url)
  } catch (e) {
    return ok({ ok: false, msg: '请求微信失败：' + e.message })
  }
  // 40029=code 失效/已用；40013=appid 错；40125=appsecret 错；40163=code 已用过
  if (body.errcode) {
    return ok({ ok: false, msg: `微信返回错误 ${body.errcode}: ${body.errmsg || ''}` })
  }
  const mpOpenid = body.openid
  if (!mpOpenid) return ok({ ok: false, msg: '未拿到服务号 openid' })

  // 1) 写入 / 更新「当前小程序 openid」对应的 users 文档
  try {
    const ex = await db.collection(COL.users).doc(openid).get().catch(() => null)
    if (ex && ex.data) {
      await db.collection(COL.users).doc(openid).update({ data: { mpOpenid, mpAuthAt: Date.now() } })
    } else {
      await db.collection(COL.users).doc(openid).set({ data: { openid, mpOpenid, mpAuthAt: Date.now() } })
    }

    // 2) unionid 兜底：若该用户已存 unionid，把同 unionid 的其他 users 文档也补上 mpOpenid
    const unionid = (ex && ex.data && ex.data.unionid) || ''
    if (unionid) {
      await db.collection(COL.users)
        .where({ unionid, _id: db.command.neq(openid) })
        .update({ data: { mpOpenid, mpAuthAt: Date.now() } })
        .catch(() => {})
    }
  } catch (e) {
    return ok({ ok: false, msg: '写入 users 失败：' + e.message })
  }

  return ok({ ok: true, mpOpenid })
}
