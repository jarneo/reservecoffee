// mpChatHttp — 公众号 AI 助理 · HTTP 入口（公众号「服务器配置」通道）
//
// 为什么需要它：云开发「消息推送」把公众号消息投递到云函数，无法从外部验证是否配通；
// 而「服务器配置」是公众号官方标准通道，URL 指向本函数后：
//   · GET  → 签名校验，原样回 echostr（公众号后台点保存时验证用）
//   · POST → 微信推送 XML 消息，本函数解析后跑 AI，**直接 return XML 被动回复**
//
// 被动回复的关键优势：不需要 access_token、不走公网、不受公众号 IP 白名单限制。
// 在个人开发版（无固定出口 IP、IP 白名单无法放行云函数漂移 IP）下，这是唯一 100% 可达的回复通道。
//
// 【2026-09-23 二期：卡片 + 直达链接】
// 被动回复本身只能发文本，但可以发「图文消息(news)」——卡片外观 + 可点击跳转。
// 跳转链接用 **小程序**（而非服务号）身份生成 URL Link：实测小程序 access_token 不受 IP 白名单约束
// （真实 AppID + 错 secret 返回 40125 而非 40164），这是白名单死局下唯一的免费直达通路。
// 成功 → 回图文卡片（点一下带参直达小程序确认页，且透传 log 供漏斗回写）；失败 → 回文本 + 菜单引导。
//
// 【2026-09-23 三期：二维码】
// 「独立的图片消息」不可行：被动回复的 image 必须带 MediaId，MediaId 只能由公众号素材接口上传，
// 而该接口要服务号 token（被 IP 白名单拦死）。可行形态 = news 的 PicUrl 填小程序码图（接受任意公网链接）。
// 定稿做法：把小程序码用 Pillow 烘焙进品牌卡片（deploy/wxa-qr.py）→ 传静态托管 → PicUrl 指过去。
//   · 静态图是**永久公网链接**，而运行时生成只能拿到云存储的临时签名链接（2h 过期）→ 静态图更稳且更快。
//   · 入口码是通用的（scene=oa / pages/ai/ai），不因人而异，一次烘焙终身可用。
// 命令：「#qr」或消息含「二维码」→ 回带码卡片（静态图，秒回）；「#qrgen」→ 实时生成（诊断接口是否可用）；
//       「#link」→ 只验 URL Link。
//
// ⚠️ URL Link 参数：只有 is_expire:false（永久链接）稳过。expire_type:1 + expire_time 会报
//   85401「time limit between 1min and 30days」，即便时间戳落在合法区间内也一样。
//
// 【2026-09-23 四期：排障与落地页】
// 真机反馈四件事，逐条定位后的处置：
//   ① 卡片日期整体晚一天 → aiCore 的 ymdBj() 双重时区平移（已修，见 aiCore 文件头）
//   ② 点卡片进小程序、但没有确认内容 → 落地页由 AI 对话页改为**常规确认页**
//      （对话页没有资料表单，新顾客填不了；确认页自带称呼/手机号/获取手机号按钮/人数上限提示）
//   ③ 人数被静默按 1 人确认 → 人数缺失改为追问 + 从用户原话兜底解析
//   ④ 超上限只默默按上限给卡 → 改为明确告知「单次最多 N 人」
// 新增两条排障命令（公众号私聊秒回，不走 AI）：
//   「#date」→ 打印真实的「北京时间 / 今天明天后天 / 短语解析 / 人数解析」
//   「#oa」  → 用真实可约场次生成一条与卡片同款的链接，用来点验落地页是否带过去信息
//
// 部署：HTTP 云函数，经 CloudBase HTTP 网关路由（/mp-chat）暴露为公网 URL。
// 公众号后台：设置与开发 → 基本配置 → 服务器配置 → 填 URL + Token，消息加解密方式选「明文模式」。
const crypto = require('crypto')
const { db, _, COL } = require('./lib')
const { generateUrlLinkCached, getWxaQrCode } = require('./lib')
const { runChat, FILL_REQUIRED_NOTE } = require('./aiCore')

// 服务器配置 Token（公众号后台填同一个值）。可在 config.mp.pushToken 覆盖。
const DEFAULT_TOKEN = 'reservecoffee2026'
// 微信被动回复死线 5 秒（自微信发出请求起算）。t0 从收到请求就开始计时，
// 超过此预算就不再尝试额外调用（如 URL Link，约 0.1~0.3s），直接回一条能立刻返回的文本。
const AI_BUDGET_MS = 4000
// URL Link 生成的硬超时：它是"锦上添花"（把文本换成可点卡片），不能让它把整个回复拖过 5 秒死线。
// 命中容器内缓存时是 0 网络往返；首次生成实测 600~1000ms。给 800ms 上限，
// 最坏 4000 + 800 = 4.8s 仍在死线内；被砍掉就回落成文本 + 菜单引导（与旧行为一致，不会更差）。
const LINK_TIMEOUT_MS = 800

// 卡片配图 —— 必须公网可访问的 https 图。可用环境变量覆盖。
// ⭐ 默认图已**烘焙进小程序码**（二曜路8号品牌卡片 + 右下角小程序码），所以确认卡片本身就带二维码，
//    顾客不用去找菜单。换成别的图会同时丢掉二维码，改之前请重新合成（见 deploy/wxa-qr.py）。
const OA_CARD_PIC = process.env.OA_CARD_PIC ||
  'https://cloud1-d8g9mhgxm32d2eac6-1468614423.tcloudbaseapp.com/oa/card-qr.jpg'
// 入口卡片的配图（`#qr` / 含「二维码」关键词）。默认与确认卡片同一张，也可单独指一张纯二维码图
// （静态托管上已备好 oa/qr.png 纯码，需要时把 OA_QR_PIC 指过去）。
const OA_QR_PIC = process.env.OA_QR_PIC || OA_CARD_PIC
// 确认场景的回复形态：
//   'card'（默认）= 图文消息卡片，点整张卡片直达小程序（信息最聚合）
//   'text'        = 保留 AI 原话 + 附可点击的 URL Link（话术更完整，无卡片外观）
// 若卡片渲染效果不合预期，把环境变量 OA_REPLY_STYLE 改成 text 即可切换，无需改代码。
const OA_REPLY_STYLE = String(process.env.OA_REPLY_STYLE || 'card').toLowerCase()

// ===== XML 解析（明文模式，够用且比引第三方库轻）=====
function pickXml(xml, tag) {
  const m = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(xml)
    || new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m ? m[1] : ''
}

// ===== 签名校验（仅记录，不拦截：Token 填错时仍能回复，便于排障）=====
function checkSign(q, token) {
  const { signature = '', timestamp = '', nonce = '' } = q || {}
  const sha = crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
  return sha === signature
}

// ===== 被动回复 XML =====
function xmlText(toUser, fromUser, content) {
  return `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName>` +
    `<FromUserName><![CDATA[${fromUser}]]></FromUserName>` +
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>` +
    `<MsgType><![CDATA[text]]></MsgType>` +
    `<Content><![CDATA[${String(content || '').slice(0, 580)}]]></Content></xml>`
}

// ===== 被动回复·图文消息（卡片外观 + 点击跳转）=====
// 官方被动回复支持 text/image/voice/video/music/news；news 即「图文消息卡片」。
// Url 指向 URL Link（wxaurl.cn）→ 微信内点一下直接唤起小程序。
function xmlNews(toUser, fromUser, item) {
  const cdata = (s) => `<![CDATA[${String(s == null ? '' : s)}]]>`
  return `<xml><ToUserName>${cdata(toUser)}</ToUserName>` +
    `<FromUserName>${cdata(fromUser)}</FromUserName>` +
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>` +
    `<MsgType>${cdata('news')}</MsgType>` +
    `<ArticleCount>1</ArticleCount>` +
    `<Articles><item>` +
    `<Title>${cdata(item.title)}</Title>` +
    `<Description>${cdata(item.desc)}</Description>` +
    `<PicUrl>${cdata(item.pic)}</PicUrl>` +
    `<Url>${cdata(item.url)}</Url>` +
    `</item></Articles></xml>`
}

const R = (body, type) => ({
  statusCode: 200,
  headers: { 'Content-Type': type || 'text/plain; charset=utf-8' },
  body: String(body == null ? '' : body)
})

// 容器内 Token 缓存（避免每次请求都读库）
let _tokCache = { at: 0, v: '' }

// ===== 与 mpChat 相同的会话/用户维护逻辑 =====
async function ensureOaUser(openid) {
  if (!openid) return
  try {
    const ex = await db.collection('oaUsers').doc(openid).get().catch(() => null)
    if (ex && ex.data) await db.collection('oaUsers').doc(openid).update({ data: { lastAt: Date.now() } })
    else await db.collection('oaUsers').doc(openid).set({ data: { openid, unionid: '', createdAt: Date.now(), lastAt: Date.now() } })
  } catch (e) { console.warn('[mpChatHttp] ensureOaUser ignored:', e && (e.message || e.errMsg)) }
}

async function loadHistory(openid) {
  try {
    const res = await db.collection('oaChat').where({ openid }).orderBy('createdAt', 'desc').limit(20).get()
    // ⚠️ 两层防污染（2026-09-23，「今天被认成第二天」第三次复现的根因修复）：
    //   根因不是日期函数算错（#date 自检全对），而是**历史污染 + 自我延续**：
    //   旧线程里 AI 说过错误日期（旧版双重平移的遗留），loadHistory 把它重放给模型，
    //   弱模型信任自己过去说的话胜过 system prompt，每轮又把错误写回 oaChat ——
    //   修了代码也治不好旧线程，错误在同一条对话串里永远续命。
    //   ① 只取最近 2 小时的轮次：跨天的旧线程不再影响新对话（预约对话本来就短）；
    //   ② 丢弃含「系统时间」的 assistant 回复：那是旧版日期 bug 的泄漏话术，是主要毒源。
    const cutoff = Date.now() - 2 * 3600 * 1000
    return (res.data || []).slice().reverse()
      .filter(r => !r.createdAt || new Date(r.createdAt).getTime() > cutoff)
      .map(r => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: String(r.content || '') }))
      .filter(m => m.content && !(m.role === 'assistant' && m.content.indexOf('系统时间') >= 0))
  } catch (e) { console.warn('[mpChatHttp] loadHistory ignored:', e && (e.message || e.errMsg)); return [] }
}

async function saveTurn(openid, role, content, msgId) {
  try {
    await db.collection('oaChat').add({
      data: { openid, role, content: String(content || '').slice(0, 2000), msgId: msgId || '', createdAt: db.serverDate() }
    })
  } catch (e) { console.warn('[mpChatHttp] saveTurn ignored:', e && (e.message || e.errMsg)) }
}

// 去重语义 = 这条 MsgId **是否已经被成功回复过**（只认 assistant 记录）。
// ⚠️ 为什么不能拿 user 记录当判据（这是「发了消息完全没回复」的隐藏根因，2026-09-23 修复）：
//   user turn 是在调 AI **之前**就落库的。若用它判重，一旦本次回复因被动回复 5 秒死线
//   没被微信接收，微信会重发**同一条消息（同一 MsgId）** —— 而重发会被判「重复」直接
//   return 'success'（什么都不回）⇒ 用户永远收不到任何回复，且是静默失败、无从察觉。
//   改为只认 assistant 记录后：没成功回复过的消息，重发一定还会被重新处理（重发时链接已入缓存、AI 也热了，更容易成功）。
async function seenMsgId(msgId) {
  if (!msgId) return false
  try {
    const r = await db.collection('oaChat').where({ msgId, role: 'assistant' }).limit(1).get()
    return !!(r.data && r.data.length)
  } catch (e) { return false }
}

// 落 assistant 回复，并决定是否写「去重标记」。
// 只在「这次回复很可能在 5 秒死线内送达微信」时才带 msgId：超窗的那一次不写标记，
// 好让微信的重发能被重新处理（重发时 URL Link 已进容器缓存、AI 也热了，更容易成功送达）。
// 这是"偶发超时最终仍能送达"的自愈路径；闭眼写标记则会让超时那次把重发一起吞掉。
const SAFE_REPLY_MS = 4600
async function markReplied(openid, reply, msgId, t0) {
  const elapsed = Date.now() - t0
  const safe = elapsed < SAFE_REPLY_MS
  if (!safe) console.warn('[mpChatHttp] 回复耗时 ' + elapsed + 'ms 已超安全窗口，本次不落去重标记，留给微信重发重试')
  await saveTurn(openid, 'assistant', reply, safe ? msgId : '')
}

async function loadToken() {
  // 容器内缓存 60s：Token 只用于签名比对记录，不值得每次请求都读一次库（5 秒预算很紧）
  const now = Date.now()
  if (_tokCache.v && (now - _tokCache.at) < 60000) return _tokCache.v
  let v = process.env.MP_PUSH_TOKEN || DEFAULT_TOKEN
  try {
    const r = await db.collection('config').doc('mp').get().catch(() => ({ data: null }))
    if (r && r.data && r.data.pushToken) v = String(r.data.pushToken)
  } catch (e) {}
  _tokCache = { at: now, v }
  return v
}

// 欢迎语（config.mp.welcome）
async function loadWelcome() {
  try {
    const r = await db.collection('config').doc('mp').get().catch(() => ({ data: null }))
    const w = r && r.data && r.data.welcome
    return (typeof w === 'string' && w.trim()) ? w.trim() : ''
  } catch (e) { return '' }
}

// ===== 卡片落地页 =====
// ⭐ 默认落到「常规确认页」pages/confirm/confirm，而不是 AI 对话页 pages/ai/ai。
//   为什么换：确认页本身就已经具备顾客下单所需的一切 ——
//     · 项目 / 日期 / 场次 / 剩余名额、称呼（type=nickname，可一键填微信昵称）
//     · 手机号输入 + 「获取手机号」按钮（open-type=getPhoneNumber）
//     · 人数步进器，且直接标注「单次最多 N 人」
//   而 AI 对话页只负责聊天，没有资料表单：新顾客点进来会卡在"填不了、提交不了"（真机复现）。
//   落地页改成确认页后，顾客点一次卡片即到表单，少一跳也少一次出错。
// 需要回退到 AI 对话页时：把环境变量 OA_HANDOFF_PAGE 设为 pages/ai/ai。
const OA_HANDOFF_PAGE = String(process.env.OA_HANDOFF_PAGE || 'pages/confirm/confirm').replace(/^\//, '')

// 直达小程序确认页的路径参数
function buildPath(c, logId) {
  const q = [
    'from=oa',
    'projectId=' + encodeURIComponent(c.projectId || ''),
    'date=' + encodeURIComponent(c.date || ''),
    'sessionId=' + encodeURIComponent(c.sessionId || ''),
    'partySize=' + encodeURIComponent(String(c.partySize || 1)),
    'projectName=' + encodeURIComponent(c.projectName || ''),
    'start=' + encodeURIComponent(c.sessionStart || ''),
    'end=' + encodeURIComponent(c.sessionEnd || '')
  ]
  if (logId) q.push('log=' + encodeURIComponent(logId))
  return OA_HANDOFF_PAGE + '?' + q.join('&')
}

// 用真实 HTTP 接口生成「URL Link」：https://api.weixin.qq.com/wxa/generate_urllink
// 为什么不用 cloud.openapi.urllink.generate（云调用）：云调用要求函数由**小程序端**发起带 WX 上下文，
// 公众号消息走的是 HTTP 网关，ctx.APPID 为空 ⇒ 恒报 -501001。改为直连小程序接口，绕开该限制。
// 为什么小程序接口能通、服务号接口不通：小程序 access_token 不走 IP 白名单（实测 40125 ≠ 40164）。
async function tryUrlLink(c, logId) {
  const p = buildPath(c, logId)
  const qi = p.indexOf('?')
  const path = qi > 0 ? p.slice(0, qi) : p
  const query = qi > 0 ? p.slice(qi + 1) : ''
  const t = Date.now()
  // 硬超时保护：链接只是"锦上添花"，不允许它把回复拖过被动回复 5 秒死线
  const link = await Promise.race([
    generateUrlLinkCached(path, query),
    new Promise((_, rej) => setTimeout(() => rej(new Error('URL Link 生成超时 ' + LINK_TIMEOUT_MS + 'ms')), LINK_TIMEOUT_MS))
  ])
  console.log('[mpChatHttp] URL Link 生成成功 ' + (Date.now() - t) + 'ms')
  return link
}

// 确认卡片文案
// ⚠️ 卡片形态下 AI 的原话（reply）会被**丢弃**（图文消息只显示 Title/Description），
// 所以任何「必须让顾客看到」的信息都要写进 Description ——
// 尤其是人数超单次上限时的说明（上限是多少、已按几位安排、更多位找谁），
// 否则顾客说了 5 个人却看到「2 位」，会以为系统出错（线上复现）。
function confirmCard(c, link) {
  const title = `预约确认 · ${c.projectName || '到店预约'}`
  const note = c.note ? String(c.note) + '。' : ''
  // 卡片形态下微信只显示 标题 + Description（AI 原话会被丢弃）⇒ 必填资料提示必须拼进 Description，
  // 否则顾客点进小程序才发现称呼/手机号缺一不可（真机反馈："AI 说不留也能约"）。
  const fill = (c.fillNote || FILL_REQUIRED_NOTE) + '。'
  const desc = `${confirmLine(c)}${note}${fill}点击进入小程序即可完成预约。`
  return { title, desc, pic: OA_CARD_PIC, url: link }
}

// 「2026-09-24 14:00-15:30，2位。」这种一行摘要
function confirmLine(c) {
  const dt = String(c.date || '')
  const range = [c.sessionStart, c.sessionEnd].filter(Boolean).join('-')
  const when = [dt, range].filter(Boolean).join(' ')
  return (when ? when + '，' : '') + (c.partySize || 1) + '位。'
}

const OA_GUIDE = '\n\n👉 点击公众号底部菜单「法兰绒预约」即可进入小程序完成预约。'

// ===== 二维码能力 =====
// 为什么不做「独立的图片消息」：被动回复的 image 消息必须带 MediaId，而 MediaId 只能由公众号素材接口
// 上传获得，该接口要服务号 access_token —— 服务号 token 被 IP 白名单拦死（出口 IP 漂移，白名单上限 20 个）。
// 免费的可行形态 = 图文消息(news)：PicUrl 接受任意公网图片链接，不需要任何微信素材接口。
//
// ⭐ 2026-09-23 定稿：卡片配图用**静态托管的成品图**（品牌卡片 + 右下角已烘焙好的小程序码）：
//   design/card-with-qr.jpg → 上传到静态托管 oa/card-qr.jpg → 填进 PicUrl。
//   为什么不在请求里实时生成：
//     ① 实时生成的码只能落到云存储，取到的是**临时签名链接**（maxAge 2h，带 ?sign=&t=），过期后旧卡片变裂图；
//     ② 生成 + 上传 + 换链接是 3 次网络往返，被动回复 5s 预算里非常昂贵（实测约 +1.2s）。
//   入口二维码是**通用**的（scene=oa、page=pages/ai/ai），不因人而异 ⇒ 一次性烘焙即可，永久有效。
//   运行时生成仅保留在 `#qrgen` 诊断命令里，用于验证「密钥 → 生成码 → 云存储」链路是否仍然通。

// 云存储临时链接（`#qrgen` 诊断用；PicUrl 必须能被微信服务器拉到）
async function uploadQrToStorage(buf) {
  const { cloud } = require('./lib')
  const up = await cloud.uploadFile({ cloudPath: 'oa/qr/qr-' + Date.now() + '.png', fileContent: buf })
  const r = await cloud.getTempFileURL({ fileList: [{ fileID: up.fileID, maxAge: 7200 }] })
  const item = (r && r.fileList && r.fileList[0]) || {}
  if (item.status !== 0 || !item.tempFileURL) {
    throw new Error('云存储临时链接失败：' + JSON.stringify(item).slice(0, 160))
  }
  return item.tempFileURL
}

// 带小程序码的入口卡片（生产路径：用静态图 + 永久 URL Link，全程 0 次额外网络往返）
async function qrCard() {
  const link = await generateUrlLinkCached('pages/ai/ai', 'from=oa').catch(() => '')
  return {
    title: '二曜路8号 · 小程序入口',
    desc: '长按图片识别小程序码，或点本卡片直接进入小程序。',
    pic: OA_QR_PIC,
    url: link || OA_QR_PIC
  }
}

// 运行时实时生成（仅 `#qrgen` 诊断用）
async function qrCardLive() {
  const buf = await getWxaQrCode('pages/ai/ai', 'oa', 430)
  const pic = await uploadQrToStorage(buf)
  const link = await generateUrlLinkCached('pages/ai/ai', 'from=oa').catch(() => '')
  return {
    title: '二曜路8号 · 小程序入口（实时生成）',
    desc: '诊断用：实时生成小程序码 + 云存储临时链接。',
    pic,
    url: link || pic
  }
}

// ===== 诊断样本：捡一个真实可约场次，拼成与确认卡片同款的 confirmation =====
// 仅 `#oa` 命令使用，用来验证「卡片 → 小程序确认页」这条落地链路。
async function sampleConfirmation() {
  const { ymdBj, addDaysBj } = require('./aiCore')
  const { bjTs } = require('./lib')
  const today = ymdBj()
  const maxWin = addDaysBj(30)
  const proj = await db.collection(COL.projects)
    .where({ published: true, deleted: _.neq(true) }).orderBy('createdAt', 'asc').get()
  for (const p of (proj.data || [])) {
    if (p.paused) continue
    const sch = await db.collection(COL.schedules)
      .where({ projectId: p._id }).orderBy('date', 'asc').limit(200)
      .get().catch(() => ({ data: [] }))
    for (const s of (sch.data || [])) {
      if (s.closed || s.date < today || s.date > maxWin) continue
      const sess = (s.sessions || []).filter(x => !x.paused
        && (x.capacity - (x.booked || 0)) > 0
        && !(bjTs(s.date, x.start) < Date.now()))
      if (!sess.length) continue
      const x = sess[0]
      return {
        projectId: p._id, projectName: p.name, date: s.date,
        sessionId: x.id, sessionStart: x.start, sessionEnd: x.end, partySize: 1
      }
    }
  }
  return null
}

// ===== 主入口（HTTP 云函数）=====
exports.main = async (event) => {
  const e = event || {}
  const method = (e.httpMethod || e.method || (e.headers && e.headers['httpMethod']) || 'GET').toUpperCase()
  const q = e.queryStringParameters || e.query || {}
  let body = e.body || ''
  if (e.isBase64Encoded && body) { try { body = Buffer.from(body, 'base64').toString('utf8') } catch (_) {} }

  const token = await loadToken()

  // ① 服务器配置校验：GET 带 echostr，原样返回即通过
  if (method === 'GET') {
    const okSign = checkSign(q, token)
    console.log('[mpChatHttp] GET 校验 signature=', okSign ? 'ok' : 'MISMATCH(仅提示)', 'echostr=', q.echostr || '(none)')
    return R(q.echostr || 'success')
  }

  // ② POST：微信推送的消息
  const xml = String(body || '')
  const msgType = String(pickXml(xml, 'MsgType') || '').toLowerCase()
  const from = pickXml(xml, 'FromUserName')   // 用户 openid
  const to = pickXml(xml, 'ToUserName')       // 公众号原始 ID
  const evt = String(pickXml(xml, 'Event') || '').toLowerCase()
  const content = String(pickXml(xml, 'Content') || '').trim()
  const msgId = pickXml(xml, 'MsgId')

  console.log('[mpChatHttp] POST msgType=' + msgType + ' event=' + evt + ' from=' + from + ' sign=' + (checkSign(q, token) ? 'ok' : 'MISMATCH(仅提示)'))

  if (!from) return R('success')

  // 关注事件：维护公众号用户索引 + 欢迎语
  if (msgType === 'event') {
    if (/unsubscribe/.test(evt)) { await ensureOaUser(from); return R('success') }
    if (/subscribe/.test(evt)) {
      await ensureOaUser(from)
      const w = await loadWelcome()
      if (w) return R(xmlText(from, to, w), 'text/xml; charset=utf-8')
    }
    return R('success')
  }

  if (msgType !== 'text' || !content) return R('success')

  // ===== 排障命令：私聊发「#date」→ 回一条「北京时间 / 日期解析 / 人数解析」自检结果（不走 AI，秒回）=====
  // 用途：日期与人数是 AI 预约里最容易出错、且出错后顾客无法自行纠正的两项
  //   （日期算错 → 约到不对的日子；人数漏抽 → 2 人位变 1 人位）。
  // 这条命令把 aiCore 里真正在用的函数直接跑给你看，避免"改完不知道有没有生效"。
  if (content === '#date') {
    try {
      const { ymdBj, addDaysBj, parseDate, parsePartySize } = require('./aiCore')
      const now = new Date(Date.now() + 8 * 3600 * 1000)
      const wd = '日一二三四五六'[now.getUTCDay()]
      const lines = [
        `当前真实时刻(UTC)=${new Date().toISOString().slice(0, 16)}`,
        `北京墙钟=${now.toISOString().slice(0, 16).replace('T', ' ')}`,
        `今天=${ymdBj()} 星期${wd}`,
        `明天=${addDaysBj(1)}　后天=${addDaysBj(2)}　昨天=${addDaysBj(-1)}`,
        `短语解析："明天"→${parseDate('明天')}　"今天"→${parseDate('今天')}　"后天"→${parseDate('后天')}　"周六"→${parseDate('周六')}`,
        `人数解析："两位"→${parsePartySize('', '两位')}　"一共3人"→${parsePartySize('', '一共3人')}　"四个人"→${parsePartySize('', '四个人')}　模型传2→${parsePartySize(2, '')}`
      ]
      return R(xmlText(from, to, '【时间/人数自检】\n' + lines.join('\n')), 'text/xml; charset=utf-8')
    } catch (e) {
      return R(xmlText(from, to, '【时间自检】❌ ' + String((e && (e.message || e)) || '').slice(0, 220)), 'text/xml; charset=utf-8')
    }
  }

  // ===== 排障命令：私聊发「#oa」→ 用**真实可约场次**生成一条与卡片同款的链接 =====
  // 用途：验证「卡片点击 → 小程序确认页」这一步到底有没有把预约信息带过去。
  // 顾客看不到本人信息，所以这里捡一个真实在售场次做样本；点进去应看到确认表单（项目/日期/时段/称呼/手机号/人数）。
  if (content === '#oa') {
    const t = Date.now()
    try {
      const c = await sampleConfirmation()
      if (!c) return R(xmlText(from, to, '【确认页自检】❌ 找不到可约场次，无法拼测试链接。'), 'text/xml; charset=utf-8')
      const link = await tryUrlLink(c, '')
      return R(xmlText(from, to,
        `【确认页自检】✅ ${Date.now() - t}ms\n落地页 = ${OA_HANDOFF_PAGE}\n期望看到：「${c.projectName}」${c.date} ${c.sessionStart}-${c.sessionEnd}，1 人位的确认表单（含称呼 / 手机号 / 人数）。\n${link}`
      ), 'text/xml; charset=utf-8')
    } catch (e) {
      return R(xmlText(from, to, '【确认页自检】❌ 失败：' + String((e && (e.message || e)) || '').slice(0, 220)), 'text/xml; charset=utf-8')
    }
  }

  // ===== 排障命令：私聊发「#link」→ 立即回一条 URL Link 自检结果（不走 AI，秒回）=====
  // 用于验证「小程序 AppSecret → access_token → generate_urllink」整条链路是否打通；
  // 返回的链接可直接点，能跳进小程序就说明卡片通道已就绪。
  // 支持带参数：`#link <pagePath>|<query>` —— 用来给公众号菜单/群发文案批量生成永久直达链接
  // （properties：`is_expire:false`，永久有效；query 为空时用 AI 页默认参数）
  if (content.indexOf('#link') === 0) {
    const t = Date.now()
    const rest = content.slice(5).trim()
    const seg = rest.split('|')
    const path = String(seg[0] || '').trim() || 'pages/ai/ai'
    const query = String(seg.slice(1).join('|') || '').trim()
      || 'from=oa&projectId=&date=&sessionId=&partySize=1&projectName='
    try {
      const link = await generateUrlLinkCached(path, query)
      return R(xmlText(from, to, `【链接自检】✅ 生成成功（${Date.now() - t}ms）\n${path}\n${link}\n\n点上面的链接试试，能进小程序就说明卡片通道已通。`), 'text/xml; charset=utf-8')
    } catch (e) {
      return R(xmlText(from, to, `【链接自检】❌ 失败：${String(e && (e.message || e)).slice(0, 220)}`), 'text/xml; charset=utf-8')
    }
  }

  // ===== 二维码：私聊发「#qr」，或消息里含「二维码」→ 回「带二维码的卡片」（不走 AI）=====
  // 卡片封面 = 静态托管上已烘焙好小程序码的成品图（永久有效）；点整张卡片也能直达小程序（Url 是 URL Link）。
  // 注：这不是微信官方的 image 消息（那个必须用服务号 token 传素材，被 IP 白名单拦死，见文件头说明）。
  // 「#qrgen」= 诊断命令，强制走「实时生成小程序码 → 云存储临时链接」的老路径，用于验证密钥/接口是否仍然可用。
  const isQrGen = content === '#qrgen'
  if (isQrGen || content === '#qr' || content.indexOf('二维码') >= 0) {
    const t = Date.now()
    try {
      const card = isQrGen ? await qrCardLive() : await qrCard()
      console.log('[mpChatHttp] 二维码卡片耗时=' + (Date.now() - t) + 'ms 形态=' + (isQrGen ? '实时生成' : '静态图'))
      return R(xmlNews(from, to, card), 'text/xml; charset=utf-8')
    } catch (e) {
      const msg = String((e && (e.message || e)) || '')
      console.warn('[mpChatHttp] 二维码生成失败：', msg)
      return R(xmlText(from, to, (isQrGen || content === '#qr')
        ? `【二维码自检】❌ 失败：${msg.slice(0, 220)}`
        : '二维码这会儿生成不出来～您也可以点公众号底部菜单「法兰绒预约」进入小程序。'), 'text/xml; charset=utf-8')
    }
  }

  const t0 = Date.now()   // 预算从「收到请求」起算，而不是从调 AI 起算
  // AI 总开关 + MsgId 去重：两者互不依赖 → 并发（少一次串行往返）
  const [aiCfg, dup] = await Promise.all([
    db.collection('config').doc('ai').get().catch(() => ({ data: null })),
    seenMsgId(msgId)
  ])
  if (aiCfg && aiCfg.data && aiCfg.data.oaEnabled === false) { console.warn('[mpChatHttp] oaEnabled=false，静默'); return R('success') }
  if (dup) { console.warn('[mpChatHttp] 重复 MsgId，跳过'); return R('success') }

  // 会话维护与历史读取并发；历史里若已含本条（saveTurn 先落库），下方做一次去重
  const [history] = await Promise.all([
    loadHistory(from),
    ensureOaUser(from),
    saveTurn(from, 'user', content, msgId)
  ])
  const last = history[history.length - 1]
  const messages = (last && last.role === 'user' && last.content === content)
    ? history
    : history.concat([{ role: 'user', content }])

  let out
  try {
    out = await runChat({
      openid: from,
      channel: 'oa',
      unionid: '',
      messages,
      projectId: '',
      nickname: '',
      channelExtra: '【公众号场景】你正在公众号里与顾客对话，无法直接下单：当顾客确认好项目/日期/时段/人数后，请告诉顾客「点击下方链接或公众号菜单即可完成预约」。'
    })
  } catch (err) {
    // 关键：即使 AI 失败也**必须回一条文本**，否则微信侧表现为「没有任何回复」
    console.error('[mpChatHttp] AI 调用失败：', err && err.message)
    const fallback = '小曜这会儿有点忙～您可以点击公众号底部菜单进入小程序预约，或稍后再问我哦。'
    await markReplied(from, fallback, msgId, t0)
    return R(xmlText(from, to, fallback), 'text/xml; charset=utf-8')
  }

  const reply = out.reply || '好的～'

  const isConfirm = out.intent === 'confirm' && out.confirmation
  let text = reply

  if (isConfirm) {
    const c = out.confirmation
    let link = ''
    if (Date.now() - t0 < AI_BUDGET_MS) {
      // 优先给「图文卡片 + 直达链接」：点一下带参进小程序确认页，并透传 log 供漏斗回写
      try { link = await tryUrlLink(c, out.logId) } catch (e) {
        console.warn('[mpChatHttp] URL Link 失败，降级为文本：', e && (e.message || e))
      }
    }
    if (link) {
      if (OA_REPLY_STYLE === 'text') {
        // 形态 B：保留 AI 原话 + 附可点链接
        text = `${reply}\n\n👉 ${confirmLine(c)}\n${link}\n（点击链接直达小程序完成预约）`
      } else {
        // 形态 A（默认）：图文卡片，点整张卡片直达
        await markReplied(from, reply, msgId, t0)
        console.log('[mpChatHttp] 被动回复耗时=' + (Date.now() - t0) + 'ms intent=confirm 形态=卡片')
        return R(xmlNews(from, to, confirmCard(c, link)), 'text/xml; charset=utf-8')
      }
    } else {
      text = reply + OA_GUIDE
    }
  }

  await markReplied(from, reply, msgId, t0)
  console.log('[mpChatHttp] 被动回复耗时=' + (Date.now() - t0) + 'ms intent=' + (out.intent || '-') + ' 形态=文本')
  return R(xmlText(from, to, text), 'text/xml; charset=utf-8')
}
