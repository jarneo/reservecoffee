// getRole — 返回当前微信用户的管理角色（无则 none）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { ok, wxCtx, getRole, ensureOwner, COL } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  if (!OPENID) return ok({ role: 'none', openid: '' })
  // 首个进入者自动成为店主
  await ensureOwner(OPENID)
  const role = await getRole(OPENID)

  // 顾客名录的「最近访问」时间源：每次冷启动必调本函数（app.js:23/33），
  // 顺带把 users.lastVisitTime 刷新为当前时刻 —— 顾客名录的「最近访问」排序与展示读它。
  // 选它而不是 config_sms.sms.visitors 的理由：visitors 是**单文档**存所有人的 map
  //   （16MB 上限 + 上面那段 read-modify-write 无锁，并发冷启动会互相覆盖丢数据），
  //   而 users.lastVisitTime 是每人一个字段，读侧（getCustomers）已整条读出 users 文档 → **零额外查询**。
  //
  // ⚠️ 必须用 update 而不是 set：
  //   ① set 会把 users 文档**其余字段全清空**（name/phone/subscriptions/黑名单/标签…全丢）；
  //   ② update 在文档不存在时会失败，此时必须**静默跳过**，绝不能顺手创建空文档 ——
  //      本函数先于 markLaunch 执行（app.js:23 vs :27），一旦抢先建出空文档，
  //      markLaunch 的「已采集过」判断会命中 → 首批新用户永远拿不到 firstLaunchAt/firstSource
  //      （首约时间 / 新客标签 / 来源统计会静默失真）。
  try {
    await db.collection(COL.users).doc(OPENID).update({ data: { lastVisitTime: Date.now() } })
  } catch (e) { /* 新用户文档还不存在 → 交给 markLaunch 建档 */ }

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
