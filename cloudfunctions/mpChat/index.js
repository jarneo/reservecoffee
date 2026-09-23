// mpChat — 微信公众号 AI 预约助理（客服消息形态）
//
// 触发方式：云开发「环境 → 消息推送」配置，把公众号消息（MsgType=text，以及 subscribe/unsubscribe 事件）指向本函数。
//   · 云开发会把 JSON 形态的消息传入 event，并在 cloud.getWXContext() 注入 FROM_OPENID / FROM_UNIONID。
//   · 用户消息不通过「被动回复」返回（那有 5 秒超时），而是用【客服消息接口】主动发出。
//
// 职责：
//   ① MsgId 去重（微信重试不得重复回复）
//   ② 取该用户近 48h 的多轮会话历史（oaChat 集合）
//   ③ 调共享 AI 核心 runChat（与小程序端同一套 NLU / 可用性 / 知识库）
//   ④ 回发：普通问答 → 文本；识别到可约时段 → 文本摘要 +【小程序卡片】导回小程序完成预约
//   ⑤ 落库：oaChat（会话原文）+ aiLogs（channel='oa'，进现有 AI 漏斗与占比统计）
//
// ⚠️ 硬依赖：
//   · 出网：客服消息要直连 api.weixin.qq.com。云环境若限制公网出站（曾出现 412）会发送失败，
//     本函数会 catch 并打 error 日志（不会崩），用户侧表现为「没收到回复」——
//     排查：云开发控制台 → 环境 → 网络配置，放行公网 / 把 api.weixin.qq.com 加入白名单。
//   · 环境变量：MP_APP_ID / MP_APP_SECRET（公众号凭证，mpAuth 已在用）
//   · 卡片封面：config.mp.cardThumbMediaId 或环境变量 MP_CARD_THUMB_MEDIA_ID；
//     未配置时自动降级为「文本 + 小程序文字链」（同样能跳转，且不需要素材）。
const { cloud, db, _, COL, wxCtx, sendMpCustom } = require('./lib')
const { runChat } = require('./aiCore')

// 小程序 AppID（卡片与文字链跳转必需；可用环境变量覆盖）
const MINI_APPID = process.env.MP_MINI_APPID || 'wxb97578ed89c6e2c7'
// 会话上下文轮数（一条用户 + 一条助理 = 一轮；这里按「消息条数」取最近 N 条）
const HISTORY_SIZE = 20
// 卡片未配置封面时的兜底跳转链接（微信要求文字链 <a> 必须带 href）
const FALLBACK_HREF = 'https://mp.weixin.qq.com/'
// 被动回复预算：微信公众号要求 5s 内响应，留足余量后剩余时间才够走「主动客服消息」
const PASSIVE_BUDGET_MS = 3500

// ===== 被动回复对象 =====
// 官方文档「云函数接收消息推送」：云函数 return 一个消息对象即视为被动回复，
// 由微信云开发直接转成 XML 回给用户 —— 不出公网、不需要 access_token、不受 IP 白名单限制。
// 这是客服消息不可用时的保底通道（缺点是只能纯文本，无法发小程序卡片）。
function passiveReply(event, openid, content) {
  const e = event || {}
  return {
    ToUserName: openid,
    FromUserName: e.ToUserName || e.toUserName || '',
    CreateTime: Math.floor(Date.now() / 1000),
    MsgType: 'text',
    Content: String(content || '').slice(0, 600)
  }
}

// 公众号侧引导语：没有卡片能力时（未配封面 / token 被 IP 白名单拦），引导走菜单
const OA_GUIDE = '\n\n👉 点击公众号底部菜单「法兰绒预约」即可进入小程序完成预约。'

// ===== 消息解析 =====
// 云开发消息推送默认 JSON；兼容公众平台直推的 XML（event.body）
function parseMsg(event) {
  const e = event || {}
  let msgType = e.MsgType || e.msgType || ''
  let content = e.Content || e.content || ''
  let msgId = e.MsgId ? String(e.MsgId) : (e.msgId ? String(e.msgId) : '')
  let evt = e.Event || e.event || ''
  if (!msgType && e.body) {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(e.body)
        || new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(e.body)
      return m ? m[1] : ''
    }
    msgType = pick('MsgType')
    content = pick('Content')
    msgId = pick('MsgId')
    evt = pick('Event')
  }
  return { msgType: String(msgType || '').toLowerCase(), content: String(content || '').trim(), msgId, evt: String(evt || '').toLowerCase() }
}

// ===== 公众号用户索引（oaUsers）=====
// 与 users（小程序身份）分开存：公众号侧独立明细，按 unionid 与小程序身份关联。
async function ensureOaUser(openid, unionid) {
  if (!openid) return
  try {
    const id = openid
    const ex = await db.collection('oaUsers').doc(id).get().catch(() => null)
    const patch = { unionid: unionid || '', lastAt: Date.now() }
    if (ex && ex.data) await db.collection('oaUsers').doc(id).update({ data: patch })
    else await db.collection('oaUsers').doc(id).set({ data: { openid, unionid: unionid || '', createdAt: Date.now(), ...patch } })
  } catch (e) {
    console.warn('[mpChat] ensureOaUser failed (ignored):', e && (e.message || e.errMsg || e))
  }
}

// ===== 关注/取关：按 unionid 关联写回小程序 users.mpOpenid（与 mpCallback 同逻辑）=====
async function handleSubscribe(openid, unionid, unsub) {
  if (unionid) {
    const users = await db.collection(COL.users).where({ unionid }).get().catch(() => ({ data: [] }))
    for (const u of (users.data || [])) {
      await db.collection(COL.users).doc(u._id).update({ data: { mpOpenid: unsub ? '' : openid } }).catch(() => {})
    }
  }
  try {
    await db.collection(COL.users).doc(`mp_${openid}`).set({
      data: { mpOpenid: openid, unionid: unionid || '', subscribed: !unsub, updatedAt: Date.now() }
    })
  } catch (e) {}
}

// ===== 会话历史（oaChat）=====
async function loadHistory(openid) {
  try {
    const res = await db.collection('oaChat').where({ openid }).orderBy('createdAt', 'desc').limit(HISTORY_SIZE).get()
    const rows = (res.data || []).slice().reverse()
    return rows.map(r => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: String(r.content || '') }))
      .filter(m => m.content)
  } catch (e) {
    console.warn('[mpChat] loadHistory failed (ignored):', e && (e.message || e.errMsg || e))
    return []
  }
}

async function saveTurn(openid, role, content, msgId) {
  try {
    await db.collection('oaChat').add({
      data: { openid, role, content: String(content || '').slice(0, 2000), msgId: msgId || '', createdAt: db.serverDate() }
    })
  } catch (e) {
    console.warn('[mpChat] saveTurn failed (ignored):', e && (e.message || e.errMsg || e))
  }
}

async function seenMsgId(msgId) {
  if (!msgId) return false
  try {
    const r = await db.collection('oaChat').where({ msgId }).limit(1).get()
    return !!(r.data && r.data.length)
  } catch (e) { return false }
}

// ===== 卡片 / 文字链构造 =====
// 把确认信息塞进小程序路径：进 pages/ai/ai 直接渲染确认卡，不必重走对话。
// log=aiLogs 的 _id：用户确认后 createReservation 据此回写 booked=true，
// 打通「公众号 AI 沟通 → 确认 → 预约成功」漏斗第三层（否则该层恒为 0）。
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
  return 'pages/ai/ai?' + q.join('&')
}

function cardTitle(c) {
  const d = String(c.date || '').slice(5) // MM-DD
  return `${c.projectName} ${d} ${c.sessionStart}`.slice(0, 32)
}

async function loadThumb() {
  if (process.env.MP_CARD_THUMB_MEDIA_ID) return process.env.MP_CARD_THUMB_MEDIA_ID
  try {
    const r = await db.collection('config').doc('mp').get()
    return (r && r.data && r.data.cardThumbMediaId) || ''
  } catch (e) { return '' }
}

// ===== 发送（带兜底：卡片失败 → 文本 + 文字链；都失败 → 交回上层走被动回复）=====
// 约定：返回 true = 已通过客服消息发出；false/抛错 = 未发出（上层需改用被动回复）
async function replyText(openid, text) {
  await sendMpCustom({ openid, msg: { type: 'text', content: text }, isAi: true })
  return true
}

async function replyConfirm(openid, out) {
  const c = out.confirmation || {}
  const path = buildPath(c, out.logId)
  const thumb = await loadThumb()
  const summary = out.reply || '已为您查到可约时段～'

  if (thumb) {
    try {
      await sendMpCustom({
        openid,
        msg: { type: 'text', content: summary + '\n点下方卡片，确认即可完成预约～' },
        isAi: true
      })
      await sendMpCustom({
        openid,
        msg: {
          type: 'miniprogrampage',
          title: cardTitle(c),
          appid: MINI_APPID,
          pagepath: path,
          thumbMediaId: thumb
        }
      })
      return true
    } catch (e) {
      console.error('[mpChat] 小程序卡片发送失败，降级为文字链：', e && e.message)
    }
  }
  // 降级：文本 + 小程序文字链（无需封面素材，同样可跳转；需已关联小程序）
  try {
    const link = `<a href="${FALLBACK_HREF}" data-miniprogram-appid="${MINI_APPID}" data-miniprogram-path="${path}">点此确认预约 ›</a>`
    await sendMpCustom({
      openid,
      msg: { type: 'text', content: `${summary}\n${link}` },
      isAi: true
    })
    return true
  } catch (e) {
    console.error('[mpChat] 客服消息（文字链）发送失败，将转被动回复：', e && e.message)
    return false
  }
}

// ===== 通道 2·前置：URL Link（云调用，走微信内网，不受 IP 白名单限制）=====
// urllink.generate 用的是【小程序】身份，本环境绑定的正是小程序 ⇒ 比 customerServiceMessage 更可能成功。
// 生成的链接可在微信会话里直接点击并跳到小程序指定页（可带 query 参数），
// 是「客服消息走不通」时保留「直达确认页」能力的关键手段（否则只能让用户自己点菜单）。
async function genOaLink(out) {
  if (!cloud || !cloud.openapi || !cloud.openapi.urllink) return ''
  const c = out && out.confirmation
  if (!c) return ''
  try {
    const p = buildPath(c, out.logId)          // pages/ai/ai?from=oa&...
    const qi = p.indexOf('?')
    const r = await cloud.openapi.urllink.generate({
      path: qi > 0 ? p.slice(0, qi) : p,
      query: qi > 0 ? p.slice(qi + 1) : '',
      isExpire: false,
      expireType: 0
    })
    const link = (r && (r.urlLink || r.url_link || r.openlink)) || ''
    if (link) console.log('[mpChat] urllink 生成成功')
    return link
  } catch (e) {
    console.warn('[mpChat] urllink 生成失败（回落菜单引导）：', e && (e.errMsg || e.message || e))
    return ''
  }
}

// ===== 通道 2：云调用 openapi（走微信内网，不过 IP 白名单）=====
// 前提条件：本环境需在微信侧绑了开放能力；且被代调用的账号与 openid 体系匹配，否则回落。
// 放在「直连客服消息」之后尝试：直连成功就不进这里，失败则给它第二次机会。
async function replyViaOpenApi(openid, out) {
  if (!cloud || !cloud.openapi || !cloud.openapi.customerServiceMessage) return false
  const isConfirm = out && out.intent === 'confirm' && out.confirmation
  try {
    if (isConfirm) {
      const c = out.confirmation
      await cloud.openapi.customerServiceMessage.send({
        touser: openid,
        msgtype: 'text',
        text: { content: (out.reply || '已为您查到可约时段～') + '\n点下方卡片，确认即可完成预约～' }
      })
      const thumb = await loadThumb()
      if (thumb) {
        await cloud.openapi.customerServiceMessage.send({
          touser: openid,
          msgtype: 'miniprogrampage',
          miniprogrampage: {
            title: cardTitle(c),
            appid: MINI_APPID,
            pagepath: buildPath(c, out.logId),
            thumb_media_id: thumb
          }
        })
      }
    } else {
      await cloud.openapi.customerServiceMessage.send({
        touser: openid, msgtype: 'text', text: { content: out.reply || '好的～' }
      })
    }
    console.log('[mpChat] 云调用客服消息通道发送成功')
    return true
  } catch (e) {
    console.warn('[mpChat] 云调用客服消息不可用（回落被动回复）：', e && (e.errMsg || e.message || e))
    return false
  }
}

// ===== 主入口 =====
exports.main = async (event) => {
  const t0 = Date.now()
  const ctx = wxCtx() || {}
  const openid = ctx.FROM_OPENID || (event && (event.FromUserName || event.fromUserName)) || ''
  const unionid = ctx.FROM_UNIONID || ''
  if (!openid) return 'success'

  const { msgType, content, msgId, evt } = parseMsg(event)

  // ① 关注 / 取关事件：维护 mpOpenid，并可发欢迎语（config.mp.welcome）
  if (msgType === 'event' || evt) {
    const unsub = /unsubscribe/.test(evt)
    await handleSubscribe(openid, unionid, unsub)
    if (/subscribe/.test(evt) && !unsub) {
      await ensureOaUser(openid, unionid)
      try {
        const r = await db.collection('config').doc('mp').get().catch(() => ({ data: null }))
        const w = r && r.data && r.data.welcome
        if (w && typeof w === 'string' && w.trim()) {
          if (await replyText(openid, w.trim())) return 'success'
        }
      } catch (e) { console.error('[mpChat] 欢迎语发送失败：', e && e.message) }
      // 客服消息不可用时，用被动回复补上欢迎语（纯文本，同样能触达）
      const wcfg = await db.collection('config').doc('mp').get().catch(() => ({ data: null }))
      const wc = wcfg && wcfg.data && wcfg.data.welcome
      if (wc && typeof wc === 'string' && wc.trim()) return passiveReply(event, openid, wc.trim())
    }
    return 'success'
  }

  // ② 仅处理文本消息（语音/图片等暂不处理，避免无谓消耗额度）
  if (msgType !== 'text' || !content) return 'success'

  // ②′ 公众号 AI 总开关（config.ai.oaEnabled，管理台「AI 预约」页可关）
  //     关闭后不回任何消息——公众号侧没有别的入口，静默比回一句「已关闭」更不打扰。
  const aiCfg = await db.collection('config').doc('ai').get().catch(() => ({ data: null }))
  if (aiCfg && aiCfg.data && aiCfg.data.oaEnabled === false) return 'success'

  // ③ MsgId 去重：微信在超时未收到响应时会重试推送，不去重会重复回复
  if (await seenMsgId(msgId)) return 'success'

  await ensureOaUser(openid, unionid)
  await saveTurn(openid, 'user', content, msgId)

  const history = await loadHistory(openid)
  const deadlineLeft = () => PASSIVE_BUDGET_MS - (Date.now() - t0)
  let out
  try {
    out = await runChat({
      openid,
      channel: 'oa',
      unionid,
      messages: history,
      projectId: '',
      nickname: '',
      channelExtra: '【公众号场景】你正在公众号里与顾客对话，无法直接下单：当顾客确认好项目/日期/时段/人数后，请告诉顾客「点击下方小程序卡片即可完成预约」。'
    })
  } catch (e) {
    console.error('[mpChat] AI 调用失败：', e && e.message)
    return passiveReply(event, openid, '小曜这会儿有点忙～您可以点击公众号菜单进入小程序预约，或稍后再问我哦。')
  }

  const reply = out.reply || '好的～'
  await saveTurn(openid, 'assistant', reply, '')

  // ④ 回发：优先「主动客服消息」（可带小程序卡片）；不可用时转「被动回复」（纯文本保底）
  const canCustom = !!(process.env.MP_APP_ID && process.env.MP_APP_SECRET)
  const isConfirm = out.intent === 'confirm' && out.confirmation

  let sent = false
  if (canCustom && deadlineLeft() > 800) {
    try {
      sent = isConfirm ? await replyConfirm(openid, out) : await replyText(openid, reply)
    } catch (e) {
      // 最常见：IP 白名单拦截(40164) / 出网受限 / 超 48h 窗口或 5 条额度 / token 失效
      console.error('[mpChat] 客服消息发送失败，转被动回复：', e && e.message)
      sent = false
    }
  } else if (!canCustom) {
    console.warn('[mpChat] 未配置 MP_APP_ID/MP_APP_SECRET，走被动回复通道')
  } else {
    console.warn('[mpChat] 已临近 5s 回复时限，跳过客服消息直接被动回复')
  }

  if (sent) return 'success'
  // 通道 2：云调用 openapi（内网转发，不受 IP 白名单影响）
  if (deadlineLeft() > 500) {
    try { if (await replyViaOpenApi(openid, out)) return 'success' } catch (e) { /* 已内部兜底 */ }
  }
  // 通道 3：被动回复（微信官方通道，必定可达；纯文本，无法片）
  //        确认场景先把「直达链接」备好：能用就直接进确认页，拿不到才退到菜单引导。
  if (isConfirm) {
    const link = await genOaLink(out)
    if (link) return passiveReply(event, openid, `${reply}\n\n👉 ${cardTitle(out.confirmation)}\n${link}\n（点击即可进入小程序完成预约）`)
  }
  return passiveReply(event, openid, isConfirm ? reply + OA_GUIDE : reply)
}
