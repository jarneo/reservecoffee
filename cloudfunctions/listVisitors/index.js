// listVisitors — 最近访问者列表（owner 专用），用于管理员页一键授权
// 数据源：getRole 把每个访问者的 openid 记到 config_sms 文档的 visitors 映射（openid -> 时间戳）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可查看')

  // 已授权管理员的 openid，避免把已是管理员的人重复列出
  const adminsRes = await db.collection(COL.admins).get()
  const adminOpenids = new Set((adminsRes.data || []).map(a => a.openid))

  // 读取最近访问者
  let visitors = {}
  try {
    const cur = await db.collection('config_sms').doc('sms').get()
    visitors = (cur.data && cur.data.visitors) || {}
  } catch (e) { /* 集合/文档不存在时忽略 */ }

  const list = Object.keys(visitors)
    .filter(openid => !adminOpenids.has(openid))
    .map(openid => ({ openid, lastSeen: visitors[openid] || 0 }))
    .sort((a, b) => b.lastSeen - a.lastSeen)

  return ok({ list })
}
