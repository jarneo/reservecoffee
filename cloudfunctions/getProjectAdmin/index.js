// getProjectAdmin — 管理员专用项目详情（不限 published，修复草稿/下架项目进不去的 bug）
// 返回 project 全字段 + 解析后的 introImages 临时 URL + 全部日期场次
const { db, COL, ok, fail, wxCtx, getRole, cloud } = require('./lib')

async function resolveIntroImages(list) {
  if (!Array.isArray(list) || !list.length) return []
  const fileList = list.map(it => it.fileId).filter(Boolean)
  let urlMap = {}
  if (fileList.length) {
    try {
      const res = await cloud.getTempFileURL({ fileList })
      ;(res.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[getProjectAdmin] getTempFileURL failed:', e.message) }
  }
  return list
    .map(it => ({ ...it, url: urlMap[it.fileId] || '' }))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
}

// 解析单个主图（云文件ID -> 临时URL）
async function resolveImage(fileId) {
  if (!fileId) return ''
  try {
    const res = await cloud.getTempFileURL({ fileList: [fileId] })
    const f = (res.fileList || [])[0]
    return (f && f.fileID) ? f.tempFileURL : ''
  } catch (e) { console.warn('[getProjectAdmin] resolveImage failed:', e.message); return '' }
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner' && role.role !== 'manager') return fail('无权限')

  const { projectId } = event
  if (!projectId) return fail('缺少 projectId')

  const pRes = await db.collection(COL.projects).doc(projectId).get().catch(() => ({ data: null }))
  const p = pRes.data
  if (!p) return fail('项目不存在')

  const sch = await db.collection(COL.schedules)
    .where({ projectId })
    .orderBy('date', 'asc')
    .get()

  const schedules = (sch.data || []).map(s => ({
    date: s.date,
    sessions: (s.sessions || []).map(x => ({
      id: x.id,
      start: x.start,
      end: x.end,
      capacity: x.capacity,
      booked: x.booked,
      paused: !!x.paused,
      desc: x.desc || ''
    }))
  }))

  const introImages = await resolveIntroImages(p.introImages || [])

  const project = {
    _id: p._id,
    name: p.name,
    icon: p.icon,
    image: p.image,
    imageUrl: await resolveImage(p.image),
    intro: p.intro,
    introImages,
    published: !!p.published,
    needReview: !!p.needReview,
    paused: !!p.paused,
    dailyLimit: p.dailyLimit || 1,
    advanceDays: p.advanceDays || 7,
    openDays: p.openDays || [],
    useSlotTemplate: !!p.useSlotTemplate,
    slotTemplate: p.slotTemplate || [],
    smsEnabled: !!p.smsEnabled,
    smsNotice: p.smsNotice || '',
    cutoff: p.cutoff || { type: '当日', time: '18:00' },
    fields: p.fields || ['name', 'phone']
  }

  return ok({ project, schedules })
}
