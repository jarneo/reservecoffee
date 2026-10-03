// getInbox — 管理员收件箱（owner + manager 可见，各自独立的已读态）
// 收录 4 类（由各触发函数写入，统一走 _lib.pushInbox）：
//   new       新预约          createReservation（免审项目）
//   cancel    取消预约        cancelReservation（顾客取消 / 管理员代取消，带 byAdmin）
//   reviewRes 待审核预约      createReservation（项目开启 needReview）→ 跳预约审核页
//   reviewDish 待审核评价     addReview（机器检测通过、进入人工审核队列）→ 跳评价管理页
// · 不传 id ：返回列表（倒序分页）+ 未读数（全量，不受分页与「只看未读」影响）+ 总数 + 待处理实时计数
// · 传 id   ：返回单条详情（详情页直接用，省去前端缓存整条数据的脆弱链路）
// ⚠️ 未读判定走库侧 `readBy: _.neq(openid)`，计数与筛选同源，避免「列表说有但徽标说 0」。
const { db, _, COL, ok, fail, wxCtx, getRole, INBOX_COLL, inboxUnreadWhere, inNotifyScope } = require('./lib')

const SIZE = 20

// 类型白名单。⚠️ 不能用 `=== 'cancel' ? 'cancel' : 'new'` 那种二选一写法 ——
//    新增类型会被静默吞成 new（文案、标签、跳转全错），这是新增类型时最易踩的坑。
const TYPES = ['new', 'cancel', 'reviewRes', 'reviewDish']

function shape(r, openid) {
  const arr = Array.isArray(r.readBy) ? r.readBy : []
  const type = TYPES.indexOf(r.type) >= 0 ? r.type : 'new'
  const base = {
    _id: r._id,
    type,
    createdAt: Number(r.createdAt) || 0,
    unread: arr.indexOf(openid) < 0
  }
  // 评价类字段与预约类完全不同（没有场次 / 人数，有评分 / 内容 / 图片）
  if (type === 'reviewDish') {
    return Object.assign(base, {
      reviewId: r.reviewId || '',
      productId: r.productId || '',
      productName: r.productName || '',
      projectId: r.projectId || '',
      projectName: r.projectName || '',
      customerName: r.customerName || '',
      rating: Number(r.rating) || 0,
      text: r.text || '',
      imageCount: Number(r.imageCount) || 0
    })
  }
  return Object.assign(base, {
    resId: r.resId || '',
    projectId: r.projectId || '',
    projectName: r.projectName || '',
    date: r.date || '',
    sessionStart: r.sessionStart || '',
    sessionEnd: r.sessionEnd || '',
    customerName: r.customerName || '',
    phone: r.phone || '',
    count: Number(r.count) || 1,
    note: r.note || '',
    // 管理员自己取消的，列表上要能一眼区分（顾客取消才是真正要紧的）
    byAdmin: !!r.byAdmin,
    review: r.review || 'none'
  })
}

// 「待处理」实时计数：始终反映当前真实待办，与列表内容 / 分页 / 筛选无关。
// ⚠️ 为什么不把状态回写到收件箱条目上：条目是**事件留痕**（处理完不必消失），
//    若在条目上标「待审核」，管理员处理完标签还亮着会误导。
//    实时查库的另一个好处：reviewReservation / reviewAllReservations / setReview /
//    cancelReservation 四个函数**全部无需改动** —— 批量审核、顾客自行取消等
//    边角路径天生被覆盖，不存在「漏回写导致数字不降」的风险。
async function countPending() {
  const out = { res: 0, dish: 0 }
  try {
    // 与 listReviews 同口径：待审核预约 = review pending 且 status pending
    const rs = await db.collection(COL.reservations).where({ review: 'pending', status: 'pending' }).count()
    out.res = (rs && rs.total) || 0
  } catch (e) { console.warn('[getInbox] pending res count failed:', e && e.message) }
  try {
    const ds = await db.collection(COL.reviews).where({ reviewStatus: 'pending' }).count()
    out.dish = (ds && ds.total) || 0
  } catch (e) { console.warn('[getInbox] pending dish count failed:', e && e.message) }
  return out
}

// 某管理员是否有某项目的接收权限（与 _lib.inNotifyScope 同源口径，空数组也归为全员）。
async function projectInScope(db, openid, projectId) {
  if (!projectId) return true
  let na = null
  try {
    const r = await db.collection(COL.projects).doc(projectId).get()
    na = r && r.data && r.data.notifyAdmins
  } catch (e) { na = null }
  return inNotifyScope(na, openid)
}

// 收件箱列表查询范围：只展示「当前管理员可接收」的项目通知。
// 与 notifyAdmins 收窄同源：notifyAdmins==='all'（或字段缺失/非法/空数组）→ 该项目对所有人可见；
// 否则仅 notifyAdmins 数组包含该 openid 的项目可见。无 projectId 的旧留痕（含空串）一律可见（无法判定，按宽松处理）。
async function inboxScopeWhere(db, openid) {
  const ids = []
  const res = await db.collection(COL.projects).limit(100).get().catch(() => ({ data: [] }))
  for (const p of (res.data || [])) {
    const inScope = inNotifyScope(p.notifyAdmins, openid)
    if (inScope && p._id) ids.push(p._id)
  }
  const conds = [{ projectId: _.exists(false) }, { projectId: _.eq('') }]
  if (ids.length) conds.push({ projectId: _.in(ids) })
  return _.or(conds)
}

exports.main = async (event) => {
  const e = event || {}
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (!role || !['owner', 'manager'].includes(role.role)) return fail('无权限')

  // 单条详情
  if (e.id) {
    const res = await db.collection(INBOX_COLL).doc(String(e.id)).get()
      .catch(err => { console.warn('[getInbox] get one failed:', err && err.message); return null })
    const d = res && res.data
    if (!d) return fail('通知不存在或已删除')
    // 安全：被项目维度收窄的管理员不得越权查看其范围外项目的通知
    if (d.projectId) {
      const inScope = await projectInScope(db, OPENID, d.projectId)
      if (!inScope) return fail('无权查看该通知')
    }
    return ok({ item: shape(d, OPENID) })
  }

  const page = Math.max(1, Number(e.page) || 1)
  const onlyUnread = !!e.onlyUnread
  const skip = (page - 1) * SIZE
  // 项目维度收窄：只展示当前管理员可接收范围内的项目通知（与 notifyAdmins 同源）
  const scope = await inboxScopeWhere(db, OPENID)
  const unreadWhere = _.and([inboxUnreadWhere(OPENID), scope])
  const where = onlyUnread ? unreadWhere : scope

  // 未读数：始终按「全部未读 + 范围」统计，与当前分页/只看未读无关
  const unreadRes = await db.collection(INBOX_COLL).where(unreadWhere).count()
    .catch(err => { console.warn('[getInbox] unread count failed:', err && err.message); return { total: 0 } })
  const totalRes = await db.collection(INBOX_COLL).where(scope).count().catch(() => ({ total: 0 }))

  // 集合不存在（还没产生过通知）时返回空列表，不报错
  const res = await db.collection(INBOX_COLL).where(where)
    .orderBy('createdAt', 'desc').skip(skip).limit(SIZE).get()
    .catch(err => { console.warn('[getInbox] query failed:', err && err.message); return { data: [] } })

  const list = (res.data || []).map(r => shape(r, OPENID))
  const pending = await countPending()

  return ok({
    list,
    unread: unreadRes.total || 0,
    total: totalRes.total || 0,
    pending,
    page,
    size: SIZE,
    hasMore: list.length === SIZE
  })
}
