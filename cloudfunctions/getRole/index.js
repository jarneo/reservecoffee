// getRole — 返回当前微信用户的管理角色（无则 none）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { ok, wxCtx, getRole, ensureOwner } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  if (!OPENID) return ok({ role: 'none', openid: '' })
  // 首个进入者自动成为店主
  await ensureOwner(OPENID)
  const role = await getRole(OPENID)
  // 记录所有访问者 openid 到 config_sms.sms.visitors（管理员页"一键授权"的数据源）
  // 文档可能不存在，用 upsert：有则 update，无则 add（自动建集合+文档）
  try {
    const cur = await db.collection('config_sms').doc('sms').get().catch(() => null)
    const visitors = (cur && cur.data && cur.data.visitors) || {}
    visitors[OPENID] = Date.now()
    if (cur && cur.data) {
      await db.collection('config_sms').doc('sms').update({ data: { visitors } })
    } else {
      await db.collection('config_sms').add({ data: { _id: 'sms', visitors } })
    }
  } catch (e) { /* ignore */ }
  return ok({ role: role.role, openid: OPENID, note: role.note || '' })
}
