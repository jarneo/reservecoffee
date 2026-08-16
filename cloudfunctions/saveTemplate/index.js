// saveTemplate — 新建/更新场次模版（owner）
const { db, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可管理模版')

  const name = String(event.name || '').trim()
  if (!name) return fail('请填写模版名称')

  const slots = Array.isArray(event.slots)
    ? event.slots.slice(0, 20).map(s => ({
        start: String(s.start || '').trim(),
        end: String(s.end || '').trim(),
        max: Math.max(1, Number(s.max) || 8)
      })).filter(s => s.start && s.end)
    : []
  if (!slots.length) return fail('请至少添加一个时段')

  await db.createCollection('templates').catch(() => {})
  const now = Date.now()
  if (event._id) {
    await db.collection('templates').doc(event._id).update({ data: { name, slots, updatedAt: now } })
  } else {
    await db.collection('templates').add({ data: { name, slots, createdAt: now, updatedAt: now } })
  }
  return ok({ saved: true })
}
