// setDayStatus — 设置某日「整体暂停 / 恢复预约」（owner / manager）
// 与场次级 paused 不同：closed 是「整日停约」，顾客端该日所有场次显示已暂停且不可选。
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId, date, closed } = event
  if (!projectId || !date) return fail('缺少参数')
  if (typeof closed !== 'boolean') return fail('closed 参数错误')

  const transaction = await db.startTransaction()
  try {
    const exist = await transaction.collection(COL.schedules).where({ projectId, date }).get()
    if (exist.data[0]) {
      await transaction.collection(COL.schedules).doc(exist.data[0]._id).update({ data: { closed } })
    } else {
      // 即便当日尚未配置场次，也可先置为暂停（防止被开放后误约）
      await transaction.collection(COL.schedules).add({ data: { projectId, date, closed, sessions: [] } })
    }
    await transaction.commit()
    return ok({ date, closed })
  } catch (e) {
    await transaction.rollback().catch(() => {})
    return fail(e.message || '操作失败')
  }
}
