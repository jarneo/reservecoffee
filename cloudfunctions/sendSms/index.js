// sendSms — 手动补发 / 测试短信（owner）
// 入参：{ reservationId } 或 { phone, name, project, date, time, status, notice }
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')
const { sendReservationSms } = require('./sms')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可发送短信')

  // 方式一：按预约记录补发
  if (event.reservationId) {
    const rRes = await db.collection(COL.reservations).doc(event.reservationId).get().catch(() => ({ data: null }))
    const r = rRes.data
    if (!r) return fail('预约不存在')
    const pRes = await db.collection(COL.projects).doc(r.projectId).get().catch(() => ({ data: null }))
    const p = pRes.data
    if (!p || !p.smsEnabled) return fail('该项目未开启短信推送')
    const out = await sendReservationSms({
      db, phone: r.phone, name: r.name, project: p.name,
      date: r.date, time: `${r.sessionStart}–${r.sessionEnd}`,
      status: r.status, notice: p.smsNotice
    })
    return ok(out)
  }

  // 方式二：直接指定参数（测试）
  const { phone, name, project, date, time, status, notice } = event
  if (!phone) return fail('缺少 phone')
  const out = await sendReservationSms({ db, phone, name, project, date, time, status, notice })
  return ok(out)
}
