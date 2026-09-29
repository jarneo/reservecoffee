// getOaMenu — 管理端「公众号菜单配置」页初始化：返回草稿 +（可选）当前线上菜单
// 草稿：config 集合文档 _id:'oaMenu' 的 menu 字段。
// 线上：cgi-bin/menu/get（需公众号 access_token；取不到时降级为 null，不影响草稿加载）。
const { db, cloud, ok, fail, getMpAccessToken, httpsJson } = require('./lib')

// 与 setOaMenu 同口径：优先云调用（免鉴权），失败回落 HTTPS 直调
const OA_APPID = process.env.MP_APP_ID || 'wx4d8d957ee8af6073'

// 与 setOaMenu 同口径：云调用返回**驼峰** { errCode, errMsg }，HTTPS 直调返回全小写 { errcode, errmsg }。
// ⚠️ 只认小写会把失败的返回当成成功（menu 字段缺失时 live 会被赋成错误对象本身）。
function pickCode(r) {
  if (!r) return 0
  const c = (r.errcode !== undefined && r.errcode !== null) ? r.errcode : r.errCode
  return (c === undefined || c === null) ? 0 : (Number(c) || 0)
}

function pickMsgOf(r) {
  if (!r) return ''
  return String(((r.errmsg !== undefined && r.errmsg !== null) ? r.errmsg : r.errMsg) || '')
}
exports.main = async () => {
  let draft = null
  try {
    const r = await db.collection('config').doc('oaMenu').get()
    if (r && r.data) draft = {
      menu: r.data.menu || null,
      clickReplies: r.data.clickReplies || {},
      lastPublish: r.data.lastPublish || null,
      // 历史版本快照（setOaMenu 每次覆盖前存一版，最多 10 版）：微信自己不留菜单历史，丢了就取不回
      history: r.data.history || [],
      updatedAt: r.data.updatedAt || 0
    }
  } catch (e) {
    // 文档不存在 → 无草稿，属正常
  }

  let live = null
  let liveVia = ''
  // ① 云调用 officialAccount.menu.get（免鉴权，不受 IP 白名单限制）
  try {
    const r = await cloud.openapi({ appid: OA_APPID }).officialAccount.menu.get({})
    console.warn('[getOaMenu] cloud get result:', JSON.stringify(r))
    const c = pickCode(r)
    if (c) console.warn('[getOaMenu] 云调用 menu.get 失败（回落直调）：', c, pickMsgOf(r))
    else if (r) { live = r.menu || r; liveVia = 'cloud' }
  } catch (e) {
    console.warn('[getOaMenu] 云调用 menu.get 失败（回落直调）：', e && (e.message || e.errMsg || e))
  }
  // ② HTTPS 直调（需 access_token：config.mpToken 缓存，或由管理端发布时写入）
  if (!liveVia) {
    try {
      const token = await getMpAccessToken()
      const j = await httpsJson('https://api.weixin.qq.com/cgi-bin/menu/get?access_token=' + encodeURIComponent(token))
      if (j && !pickCode(j)) { live = j.menu || j; liveVia = 'https' }
    } catch (e) {
      console.warn('[getOaMenu] 拉取线上菜单失败（忽略）：', e && (e.message || e.errMsg || e))
    }
  }

  // token 缓存状态（只读库，不发网络请求）：让管理端显示「缓存 token 还剩多久 / 已过期」
  let tokenInfo = { has: false, remainMin: 0, expiresAt: 0 }
  try {
    const t = await db.collection('config').doc('mpToken').get().catch(() => ({ data: null }))
    const d = t && t.data
    if (d && d.token && d.expiresAt) {
      const remainMin = Math.floor((Number(d.expiresAt) - Date.now()) / 60000)
      // getMpAccessToken 要求剩余 >5min 才复用，这里同口径
      tokenInfo = { has: remainMin > 5, remainMin, expiresAt: Number(d.expiresAt) }
    }
  } catch (e) { /* 无缓存 → 保持默认 */ }

  // 诊断：只回布尔，不回任何密钥。用于管理端提示「服务号凭证未配置 / 被 IP 白名单拦截」。
  // liveVia 暴露「云调用是否可用」，是判断环境共享有没有配好的直接依据。
  const env = {
    hasMpAppId: !!process.env.MP_APP_ID,
    hasMpSecret: !!process.env.MP_APP_SECRET,
    liveVia: liveVia || 'none'
  }

  return ok({ draft, live, env, tokenInfo })
}
