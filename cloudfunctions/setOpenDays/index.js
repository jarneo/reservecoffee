// setOpenDays — 批量开放/关闭可约日期（owner；关闭时保护「已有预约」的日期）
const { db, _, COL, ok, fail, wxCtx, getRole } = require('./lib')

function ymd(t) { const x = t || new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }

// 统计某日是否有已占额（booked>0）的场次
async function dayHasBookings(projectId, date) {
  const r = await db.collection(COL.schedules).where({ projectId, date }).get()
  const s = r.data[0]
  if (!s) return false
  return (s.sessions || []).some(x => (x.booked || 0) > 0)
}

// 删除某日残留的场次文档（孤儿场次）。关闭/移除日期时调用：避免仅从 openDays 移除而 schedules 文档残留，
// 日后重新开放该日时孤儿场次「复活」被顾客端误判为可约。调用方已对「有预约」日期做保护，此处仅清理 booked 全为 0 的日期。
async function removeScheduleForDate(projectId, date) {
  try {
    await db.collection(COL.schedules).where({ projectId, date }).remove()
  } catch (e) { console.warn('[setOpenDays] removeSchedule failed:', e && e.message) }
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可调整可约日期')

  const { projectId, action } = event
  let dates = event.dates || []
  if (!projectId || !Array.isArray(dates) || !dates.length) return fail('参数缺失')
  // 忽略过去的日期（不可操作历史日期，避免写回 openDays）
  const today = ymd(new Date())
  dates = dates.filter(d => typeof d === 'string' && d >= today)
  if (!dates.length) return fail('不能选择过去的日期')

  const pRes = await db.collection(COL.projects).doc(projectId).get().catch(() => ({ data: null }))
  const p = pRes.data
  if (!p) return fail('项目不存在')
  const openDays = new Set(p.openDays || [])

  if (action === 'open') {
    dates.forEach(d => openDays.add(d))
  } else if (action === 'close') {
    // 保护已有预约的日期
    const protectedDays = []
    for (const d of dates) {
      if (openDays.has(d) && await dayHasBookings(projectId, d)) protectedDays.push(d)
    }
    for (const d of dates) {
      if (protectedDays.includes(d)) continue
      openDays.delete(d)
      await removeScheduleForDate(projectId, d)   // 治本：同步清理孤儿场次，防止重新开放时复活
    }
    if (protectedDays.length) {
      await db.collection(COL.projects).doc(projectId).update({ data: { openDays: [...openDays] } })
      return ok({ open: [...openDays], protectedDays, message: `该日期已有人预约，无法取消当日预约：${protectedDays.join('、')}` })
    }
  } else if (action === 'set') {
    // 替换集合，但保留有预约的原日期
    const keep = []
    for (const d of (p.openDays || [])) {
      if (!dates.includes(d) && await dayHasBookings(projectId, d)) keep.push(d)
    }
    const next = new Set([...dates, ...keep])
    // 治本：清理被移除且无预约的日期的孤儿场次文档
    for (const d of (p.openDays || [])) {
      if (!next.has(d)) await removeScheduleForDate(projectId, d)
    }
    await db.collection(COL.projects).doc(projectId).update({ data: { openDays: [...next] } })
    return ok({ open: [...next], protectedDays: keep })
  } else {
    return fail('未知 action')
  }

  await db.collection(COL.projects).doc(projectId).update({ data: { openDays: [...openDays] } })
  return ok({ open: [...openDays] })
}
