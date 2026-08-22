// tmpTpl — 一次性：自动探测 6 个订阅模板的真实字段键
// 原理：send 接口在数据不完整时返回 47003 并指出缺哪个 data.thingX；
//       数据完整但用户未订阅时返回 43101。用刚才测试的 openid（日志证明未订阅）探测，
//       迭代补齐字段直到收到 43101，即得到该模板的全部必填键。不会真正下发消息。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function dummyFor(key) {
  if (key.startsWith('character_string')) return '13800138000'
  if (key.startsWith('number')) return '2'
  if (key.startsWith('date')) return '2026-08-20'
  if (key.startsWith('time')) return '13:50'
  return '探测值'
}

exports.main = async () => {
  // 取一个确定未订阅的 openid：取最近一条预约的预订人（日志里该用户所有发送均未成功）
  let openid = ''
  const r = await db.collection('reservations').orderBy('createdAt', 'desc').limit(1).get().catch(() => ({ data: [] }))
  if (r.data && r.data[0] && r.data[0].openid) openid = r.data[0].openid
  if (!openid) {
    const a = await db.collection('admins').limit(1).get().catch(() => ({ data: [] }))
    if (a.data && a.data[0]) openid = a.data[0].openid
  }
  if (!openid) return { ok: false, err: 'no openid found' }

  const TPLS = {
    reserveSuccess: 'ShNSAxZvFsDgyZhFfi3OTbofXCzjsM5P1-sSD8ZU2e4',
    reserveCancel: 'Y1VIDe6Y_DiQqzE_FaaBzvNyD2nErGogF5pCbLed_u8',
    reminder: 'OTbjHkCiDnS2a5r0-6AIf2ze41-M2flVKAKbt6LWe6c',
    adminNew: 'AJ8iCZgYFaNoSmwmrwwivnRTnJ3BvFu5sOeg4Wa-3aM',
    adminCancel: 'Y1VIDe6Y_DiQqzE_FaaBzvNyD2nErGogF5pCbLed_u8',
    adminReview: 'UQJ5AfBWVUTQO-upC-3_W-UeDu_BgPPGoyj11Ei5Py8'
  }

  const result = {}
  for (const [name, tid] of Object.entries(TPLS)) {
    const data = {}
    let lastErr = ''
    let done = false
    for (let i = 0; i < 40; i++) {
      try {
        await cloud.openapi.subscribeMessage.send({
          touser: openid, templateId: tid, data, page: 'pages/index/index'
        })
        done = true
        lastErr = 'OK(sent, 说明该 openid 已订阅此模板)'
        break
      } catch (e) {
        const msg = (e.errMsg || e.message || '')
        const m = msg.match(/data\.(\w+)\.value is empty/)
        if (m) {
          data[m[1]] = { value: dummyFor(m[1]) }
          lastErr = msg
          continue
        }
        if (msg.indexOf('43101') >= 0 || msg.indexOf('refuse') >= 0) {
          done = true
          lastErr = '43101(user refuse => 字段结构完整正确)'
          break
        }
        lastErr = msg
        break
      }
    }
    result[name] = { keys: Object.keys(data), count: Object.keys(data).length, lastErr }
  }
  return { ok: true, openid, result }
}
