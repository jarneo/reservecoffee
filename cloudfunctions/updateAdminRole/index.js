// updateAdminRole — 超级管理员调整其他管理员的角色（manager ⇄ owner）
//
// 为什么需要：原先 addAdmin 只能「新增」、removeAdmin 只能「删除」，
//   改角色只能「先删后加」→ 丢失 nickname / createdAt / inviterOpenid，
//   且中间存在该 openid 短暂无角色的窗口。
//
// ⚠️ 按 **openid** 定位而不是 adminId（文档 _id）：
//   角色是「身份属性」，openid 才是身份键。admins 的 _id 是自增的，
//   传错/传空会查不到；用 openid 也省掉一次 listAdmins 往返。
//
// 五道防护（缺一不可）：
//   ① 仅 owner 可调；
//   ② **禁止自我降级** —— 否则自己立刻失去 owner 能力，而 admins 里若已无 owner，
//      ensureOwner 的「集合为空才授予」虽已加固，但 owner 归零本身就是事故；
//   ③ **最后一个 owner 不可降级** —— 复用 removeAdmin:17-20 的同款保护；
//   ④ 写审计字段 roleChangedAt / roleChangedBy / roleChangedFrom；
//   ⑤ 幂等：已是目标角色直接返回，不抖 updatedAt（避免无意义写）。
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

const ROLES = ['owner', 'manager']

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('未登录')
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可调整角色')

  const openid = (event && event.openid) ? String(event.openid).trim() : ''
  const newRole = (event && event.role) || ''
  if (!openid) return fail('缺少 openid')
  if (ROLES.indexOf(newRole) < 0) return fail('角色非法')

  const found = await db.collection(COL.admins).where({ openid }).get().catch(() => ({ data: [] }))
  if (!found.data.length) return fail('该用户不是管理员')
  const target = found.data[0]

  const oldRole = target.role
  // ⑤ 幂等
  if (oldRole === newRole) {
    return ok({ openid, role: newRole, changed: false, message: '角色未变化' })
  }

  // ② 禁止自我降级（提权自己无所谓，但降级自己必然是误操作）
  if (openid === OPENID && newRole !== 'owner') {
    return fail('不能降级自己。若要移交店主身份，请让对方先升级、再由对方升级你。')
  }

  // ③ 最后一个 owner 不可降级
  if (oldRole === 'owner' && newRole === 'manager') {
    const owners = await db.collection(COL.admins).where({ role: 'owner' }).get().catch(() => ({ data: [] }))
    if ((owners.data || []).length <= 1) return fail('至少保留一个超级管理员，无法降级')
  }

  // ④ 写审计字段：谁在什么时候把谁从什么角色改成了什么角色
  await db.collection(COL.admins).doc(target._id).update({
    data: {
      role: newRole,
      roleChangedAt: Date.now(),
      roleChangedBy: OPENID,
      roleChangedFrom: oldRole,
      updatedAt: Date.now()
    }
  })

  return ok({ openid, role: newRole, changed: true, from: oldRole })
}
