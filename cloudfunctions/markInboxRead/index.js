// markInboxRead — 收件箱标记已读（owner + manager）
// · 带 id   ：单条已读（打开详情即调用，幂等）
// · 不带 id ：全部已读（顶部「全部已读」按钮；返回实际处理条数，供前端 toast）
const { db, ok, fail, wxCtx, getRole, markInboxRead, markInboxAllRead } = require('./lib')

exports.main = async (event) => {
  const e = event || {}
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (!role || !['owner', 'manager'].includes(role.role)) return fail('无权限')

  const id = e.id ? String(e.id) : ''
  if (id) {
    const done = await markInboxRead(db, OPENID, id)
    return ok({ id, done, unread: null })
  }

  const n = await markInboxAllRead(db, OPENID)
  return ok({ done: true, count: n })
}
