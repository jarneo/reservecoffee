// mpCallback — 微信服务号「消息推送」回调（关注 / 取消关注事件）
// 作用：采集用户「服务号 openid」，按 unionid 关联到小程序 users，供服务号模板消息送达。
// 前置：在云开发控制台「环境 → 消息推送」把事件指向本云函数；在公众平台「消息推送」配置 Token（写入环境变量 MP_TOKEN 或 config.mp.token）。
// 说明：本函数仅用云开发可信上下文（FROM_OPENID / FROM_UNIONID），不调外部接口、不需 AppSecret、不需出网。
const { cloud, db, COL, ok } = require('./lib')
const crypto = require('crypto')

function sha1(str) { return crypto.createHash('sha1').update(str).digest('hex') }
function checkSignature(token, signature, timestamp, nonce) {
  if (!token || !signature) return false
  const arr = [token, String(timestamp), String(nonce)].sort()
  return sha1(arr.join('')) === signature
}

exports.main = async (event) => {
  const q = (event && event.queryStringParameters) || event || {}
  const signature = q.signature
  const timestamp = q.timestamp
  const nonce = q.nonce
  const echostr = q.echostr

  // Token：优先环境变量，回退 config.mp.token
  let token = process.env.MP_TOKEN || ''
  if (!token) {
    try {
      const r = await db.collection('config').doc('mp').get()
      token = (r && r.data && r.data.token) || ''
    } catch (e) {}
  }

  // ① GET 验证（公众平台「服务器配置」接入校验）
  if (echostr && signature) {
    if (checkSignature(token, signature, timestamp, nonce)) return echostr
    return 'verify failed'
  }

  // ② POST 事件：来自服务号，云开发已注入 FROM_OPENID / FROM_UNIONID
  const ctx = cloud.getWXContext()
  const mpOpenid = ctx.FROM_OPENID
  const unionid = ctx.FROM_UNIONID
  if (!mpOpenid) return ok({ note: 'no from openid' })

  // 事件类型：subscribe / unsubscribe
  // 云开发消息推送默认 JSON 格式（event.Event）；兼容公众平台直接推送的 XML 文本
  let unsub = false
  const evt = (event && (event.Event || event.event)) || ''
  if (/unsubscribe/i.test(evt)) unsub = true
  if (!unsub) {
    try {
      const m = /<Event><!\[CDATA\[(.*?)\]\]><\/Event>/.exec(event.body || '')
      if (m && /unsubscribe/i.test(m[1])) unsub = true
    } catch (e) {}
  }

  // 主路径：按 unionid 关联小程序 users，写入 / 清除 mpOpenid
  if (unionid) {
    const users = await db.collection(COL.users).where({ unionid }).get().catch(() => ({ data: [] }))
    for (const u of (users.data || [])) {
      const data = unsub ? { mpOpenid: '' } : { mpOpenid }
      await db.collection(COL.users).doc(u._id).update({ data }).catch(() => {})
    }
  }

  // 维护以服务号 openid 为键的索引文档，便于按服务号 openid 反查 / 排障
  try {
    const idDoc = `mp_${mpOpenid}`
    await db.collection(COL.users).doc(idDoc).set({
      data: { mpOpenid, unionid: unionid || '', subscribed: !unsub, updatedAt: Date.now() }
    })
  } catch (e) {}

  return ok({ mpOpenid, unionid: unionid || '', unsub })
}
