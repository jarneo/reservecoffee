// saveAdminSubs — 保存**当前管理员自己**的管理推送订阅状态（admins.subscriptions）
//
// 背景：微信订阅消息是「一次性」授权，发一条消耗一条，用尽后微信返 43101。
//   原先 admins 侧完全没有订阅状态记录 → 额度耗尽后管理端零提示，管理员只能凭
//   「以前收得到、现在收不到」的人肉感知反复点「续订」。本函数把授权结果落库，
//   配合 notifyAdmins 的 43101 回写（markAdminSubInvalid），让管理台能高亮提示「该续订了」。
//
// 🔒 只能改自己：定位用 doc(OPENID)（admins.openid 即 _id? 否 —— 实际是自增 _id + openid 普通字段，
//   故先按 openid 查出记录再按 _id 更新），不允许改他人 → 天然防越权，无需 owner 校验。
//
// ⚠️ 入参只传「本次授权弹窗里 accept/reject 的键」，服务端与库中原值**合并**：
//   微信一次弹窗只返回本次涉及的模板状态；若按 normalizeAdminSubs(本次结果) 整覆盖，
//   会把本次未涉及的键白置 false → 管理员「续订了 A 模板」却连带弄丢 B、C 模板的额度。
//
// ⚠️ 'ban'（用户在小程序设置里关闭了订阅消息）必须落 false：
//   该值同样表示「不会收到」，若当 accept 处理会导致管理台一直显示正常、永远不提示续订。
const { db, COL, ok, fail, wxCtx, ADMIN_SUB_KEYS, normalizeAdminSubs } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('未登录')

  // 必须是管理员才落库（顾客调此函数无意义，直接拒绝避免写入脏数据）
  const found = await db.collection(COL.admins).where({ openid: OPENID }).get().catch(() => ({ data: [] }))
  if (!found.data.length) return fail('仅管理员可保存订阅设置')
  const me = found.data[0]

  const incoming = (event && event.subs) || {}

  // 逐键合并：只处理本次上报的键，其余保持原值
  const patch = {}
  for (const k of ADMIN_SUB_KEYS) {
    if (incoming[k] === undefined) continue
    // 仅接受布尔值；'ban' 已在调用方转成 false
    if (typeof incoming[k] !== 'boolean') return fail('订阅状态必须为布尔值：' + k)
    patch[`subscriptions.${k}`] = incoming[k]
  }
  if (!Object.keys(patch).length) return fail('未提供任何订阅状态')

  // 本次点击至少授权通过 1 个模板 → 管理员「推送额度」+1（用户自维护计数器：点击续订 +1 / 真正发出 -1，可超过 3）
  const granted = ADMIN_SUB_KEYS.some(k => incoming[k] === true)
  const newQuota = (typeof me.pushQuota === 'number' ? me.pushQuota : 0) + (granted ? 1 : 0)

  // 读回合并后的完整状态返回，供前端即时刷新卡片
  const merged = normalizeAdminSubs(Object.assign({}, me.subscriptions, incoming))

  const data = Object.assign({}, patch, { updatedAt: Date.now(), pushQuota: newQuota })
  // 本次至少有一个模板被授权 → 视为「已续订」，刷新时间戳
  if (ADMIN_SUB_KEYS.some(k => merged[k])) data.subscribedAt = Date.now()

  await db.collection(COL.admins).doc(me._id).update({ data })

  return ok({ subscriptions: merged, subscribedAt: data.subscribedAt || me.subscribedAt || 0, pushQuota: newQuota })
}
