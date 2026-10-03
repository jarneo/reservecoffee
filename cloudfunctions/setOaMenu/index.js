// setOaMenu — 发布公众号自定义菜单（管理端「公众号菜单配置」页调用）
// 复用 _lib 的 getMpAccessToken()（公众号 AppSecret 取 token + 缓存/刷新）与 httpsJson()。
// 入参：{ menu: { button: [...] } }（与微信 cgi-bin/menu/create 报文同构）
// 出参：{ code, errcode, errmsg }
//
// 🔒 权限：owner 专属。
// 本函数原先零角色校验 → 任何微信用户都能 callFunction 覆盖**线上公众号菜单**；
// 且下方支持 event.accessToken 直传落 config.mpToken 缓存 → 可把缓存污染成攻击者的
// token，导致后续所有公众号 API（取 token、发消息、菜单读写）都用攻击者凭证。
// 前端 oaMenu.js 的 guard(['owner']) 只是 UI 门禁，**云函数侧才是唯一安全边界**。
const { db, cloud, ok, fail, wxCtx, getRole, getMpAccessToken, httpsJson } = require('./lib')

// 【路线 A】云调用：免鉴权 ⇒ 不需要 access_token，直接绕开「服务号 IP 白名单 + 出口 IP 漂移」死局。
// 官方「公众号云调用」文档确认支持 officialAccount.menu.create（出入参与 HTTPS 调用一致），
// 且 cloud.openapi({ appid }) 可显式指定以公众号身份调用。
// 前置条件：小程序已把本云环境「环境共享」给该公众号（需同主体）；否则会失败并回落到 HTTPS 直调。
const OA_APPID = process.env.MP_APP_ID || 'wx4d8d957ee8af6073'

async function createMenuCloud(menu, appid) {
  const api = (typeof cloud.openapi === 'function') ? cloud.openapi({ appid }) : cloud.openapi
  const oa = api && api.officialAccount
  if (!oa || !oa.menu || typeof oa.menu.create !== 'function') {
    throw new Error('当前 wx-server-sdk 不支持 officialAccount.menu.create 云调用（需升版）')
  }
  return await oa.menu.create({ button: menu.button })
}

const MAX_TOP = 3
const MAX_SUB = 5

// ⚠️ 两套错误字段命名，必须都认：
//   · HTTPS 直调 cgi-bin/menu/create → 全小写 { errcode, errmsg }
//   · 云调用 cloud.openapi(...).officialAccount.menu.create → **驼峰** { errCode, errMsg }
// 只看小写会把「云调用失败」误判成成功（实证 9/29：errCode 非 0，库里却写成 errcode:0、via:'cloud'）。
function pickCode(r) {
  if (!r) return 0
  const c = (r.errcode !== undefined && r.errcode !== null) ? r.errcode : r.errCode
  return (c === undefined || c === null) ? 0 : (Number(c) || 0)
}
function pickMsg(r) {
  if (!r) return ''
  return String(((r.errmsg !== undefined && r.errmsg !== null) ? r.errmsg : r.errMsg) || '')
}
// 常见错误码 → 人话提示（发布失败时直接告诉店主下一步做什么）
function hintOf(code, msg) {
  const s = String(msg || '')
  if (code === 48001 || /api unauthorized/i.test(s)) return '公众号未获得该接口权限（多为未认证 / 订阅号无自定义菜单权限）'
  if (code === -501001 || /invalid wx openapi access_token/i.test(s)) return '云调用凭证无效：小程序云环境「环境共享」还没给这个公众号（需同主体），或 AppSecret 被重置'
  if (code === 40164 || /invalid ip/i.test(s)) return '调用 IP 不在公众号白名单（云函数出口 IP 随机漂移，这条路走不通，请改走云调用）'
  if (code === 40016 || code === 40018) return '菜单结构/名称非法（一级 ≤3 个、子菜单 ≤5 个；一级名 ≤4 字、子菜单名 ≤8 字）'
  if (code === 40035) return '报文含非法参数（检查 appid / pagepath / url）'
  if (code === 41001 || code === 40001) return '缺少或无效的 access_token'
  return ''
}

function lenOf(s) { return [...(s || '')].length }

// 服务端二次校验结构（与前端一致），避免脏数据直接打到微信
function validate(menu) {
  if (!menu || !Array.isArray(menu.button)) return '菜单结构非法：缺少 button 数组'
  if (menu.button.length < 1 || menu.button.length > MAX_TOP) return '一级菜单数量须为 1-' + MAX_TOP
  for (const b of menu.button) {
    if (!b.name || !b.name.trim()) return '存在未命名的一级菜单'
    if (lenOf(b.name) > 4) return '一级菜单「' + b.name + '」共 ' + lenOf(b.name) + ' 字，超过 4 字上限（微信限制：一级菜单名最多 4 个字）'
    if (b.sub_button && b.sub_button.length) {
      if (b.sub_button.length > MAX_SUB) return '「' + b.name + '」的子菜单最多 ' + MAX_SUB + ' 个'
      for (const s of b.sub_button) {
        if (!s.name || !s.name.trim()) return '存在未命名的子菜单'
        if (lenOf(s.name) > 8) return '子菜单「' + s.name + '」共 ' + lenOf(s.name) + ' 字，超过 8 字上限（微信限制：子菜单名最多 8 个字）'
        if (!s.type) return '子菜单「' + s.name + '」未选择动作类型'
      }
    } else {
      if (!b.type) return '一级菜单「' + b.name + '」未选择动作类型'
    }
  }
  return null
}

// click 类型的「回复文本」单独落库，不进 menu/create 报文：
//   · menu/create 只认 {name,type,key}，多带 replyText 有被判 40035（非法参数）的风险；
//   · 但 click 菜单点下去要靠 mpChatHttp 被动回复这段文字，必须持久化。
// 形态：{ '<EventKey>': '<回复文本>' }。key 为空、文本为空的一律丢弃。
function normalizeReplies(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  let n = 0
  for (const k of Object.keys(raw)) {
    if (n >= 50) break
    const key = String(k || '').trim()
    if (!key) continue
    const v = raw[k]
    if (typeof v !== 'string') continue
    const text = v.trim()
    if (!text) continue
    out[key] = text.slice(0, 600)
    n++
  }
  return out
}

async function createMenu(token, menu) {
  const body = JSON.stringify({ button: menu.button })
  const url = 'https://api.weixin.qq.com/cgi-bin/menu/create?access_token=' + encodeURIComponent(token)
  let j = await httpsJson(url, { method: 'POST', body })
  // token 过期/失效 → 强制刷新再试一次
  const code = pickCode(j)
  if (code === 42001 || code === 40001 || code === 40014) {
    const t2 = await getMpAccessToken(true)
    j = await httpsJson(url.replace(/access_token=[^&]*/, 'access_token=' + encodeURIComponent(t2)), { method: 'POST', body })
  }
  return j || {}
}

exports.main = async (event) => {
  // 🔒 owner 专属校验（见文件头）。不能只靠前端 guard —— 前端可被开发者工具绕过。
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可操作')

  const menu = (event && event.menu) || {}
  const err = validate(menu)
  if (err) return fail(err)
  // ⚠️ 必须在上面解构之后声明：clickReplies 由该 const 产生，提前引用会撞 TDZ（ReferenceError）。
  const clickReplies = normalizeReplies((event && event.clickReplies) || {})

  // 可选：管理端直接粘一个「已在白名单 IP 上取到的」access_token，先落缓存再发布。
  // ⚠️ 为什么需要这条路：IP 白名单**只作用于「用 AppSecret 换 token」这一步**，
  //    拿到 token 之后调 menu/create 不再校验 IP。而云函数出口 IP 完全随机漂移
  //    （实测 8 轮 8 个不同 IP），靠加白名单根本不可行 ⇒ 由店主在本机取 token 后填入。
  //    getMpAccessToken() 会先读 config.mpToken 缓存（剩余 >5min 直接用，不发网络请求）。
  const accessToken = (event && event.accessToken) ? String(event.accessToken).trim() : ''
  if (accessToken) {
    try {
      await db.collection('config').doc('mpToken').set({
        data: { token: accessToken, expiresAt: Date.now() + 7200 * 1000, updatedAt: Date.now() }
      })
    } catch (e) {
      console.warn('[setOaMenu] 写入 token 缓存失败（忽略）：', e && (e.message || e.errMsg || e))
    }
  }

  // token / menu/create 失败都**不提前 return**：草稿与回复文案仍要落库，
  // 否则「发布被 40164 拦」时，管理端辛苦编辑的菜单会随失败一起丢失。
  //
  // 两条发布通路，按顺序尝试：
  //   ① 云调用（免鉴权，官方正路） ② HTTPS 直调（需 access_token）
  let j = null
  let via = ''
  const errs = {}

  try {
    const r = await createMenuCloud(menu, OA_APPID)
    const c = pickCode(r)
    // 成败都打日志：云调用的真实 errCode/errMsg 只能从这里查（库里只存快照）
    console.warn('[setOaMenu] cloud result:', JSON.stringify(r))
    if (r && !c) { j = r; via = 'cloud' }
    else if (r) errs.cloud = '微信返回 ' + c + '：' + pickMsg(r)
    else errs.cloud = '云调用无返回'
  } catch (e) {
    errs.cloud = String((e && e.message) || e || '')
  }

  if (!via) {
    try {
      const token = await getMpAccessToken()
      const r = await createMenu(token, menu)
      const c = pickCode(r)
      console.warn('[setOaMenu] https result:', JSON.stringify(r))
      if (r && !c) { j = r; via = 'https' }
      else if (r) errs.https = '微信返回 ' + c + '：' + pickMsg(r)
      else errs.https = '直调无返回'
    } catch (e) {
      errs.https = String((e && e.message) || e || '')
    }
  }

  const publishErr = via ? ''
    : ('云调用：' + (errs.cloud || '未执行') + '｜直调：' + (errs.https || '未执行'))

  // ⚠️ 微信**不保存菜单历史版本**，create 成功即覆盖、旧配置再也要不回来。
  // 所以每次覆盖前把上一版快照存进 history（最多留 10 版），以后随时能翻旧账。
  let history = null
  try {
    const old = await db.collection('config').doc('oaMenu').get()
    const d = old && old.data
    const prev = d && d.menu
    if (prev && JSON.stringify(prev) !== JSON.stringify(menu)) {
      const arr = Array.isArray(d.history) ? d.history.slice(-9) : []
      arr.push({ ts: d.updatedAt || Date.now(), menu: prev })
      history = arr
    } else if (d && Array.isArray(d.history)) {
      history = d.history
    }
  } catch (e) {
    // 文档不存在（首次发布）→ 无历史
  }

  const code = pickCode(j)
  const msg = pickMsg(j)
  const hint = code ? hintOf(code, msg) : ''
  const data = {
    menu,
    clickReplies,
    updatedAt: Date.now(),
    lastPublish: {
      errcode: code, errmsg: msg, ts: Date.now(), hint,
      via: via || 'none',   // 'cloud' = 云调用（免鉴权）｜'https' = 直调｜'none' = 两条都失败
      errs,
      raw: JSON.stringify(j || {}).slice(0, 600)   // 原始返回快照，排查用
    }
  }
  if (history) data.history = history
  // 落库草稿 + 回复文案 + 最近发布结果（便于排查 48001 / -501001 / 40016）
  // ⚠️ 无论发布成功与否都落库：草稿是管理端的编辑成果，不能因为 token 被拦（如 40164）就丢掉。
  try {
    await db.collection('config').doc('oaMenu').set({ data })
  } catch (e) {
    console.warn('[setOaMenu] 落库失败（忽略）：', e && (e.message || e.errMsg || e))
  }

  if (publishErr) return fail(publishErr)
  if (code) return fail('微信返回 ' + code + '：' + msg + (hint ? '｜' + hint : ''))
  return ok({ errcode: 0, via })
}
