// getProject — 单项目详情 + 全部日期场次（顾客端选日期/场次用）
const { db, COL, ok, fail, cloud } = require('./lib')

// 解析介绍图片临时 URL：输入 [{fileId,...}]，返回带 url 的数组（按 sort 排序）
async function resolveIntroImages(list) {
  if (!Array.isArray(list) || !list.length) return []
  const fileList = list.map(it => it.fileId).filter(Boolean)
  let urlMap = {}
  if (fileList.length) {
    try {
      const res = await cloud.getTempFileURL({ fileList })
      ;(res.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[getProject] getTempFileURL failed:', e.message) }
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
  } catch (e) { console.warn('[getProject] resolveImage failed:', e.message); return '' }
}

exports.main = async (event) => {
  const { projectId } = event
  if (!projectId) return fail('缺少 projectId')

  const pRes = await db.collection(COL.projects).doc(projectId).get().catch(() => ({ data: null }))
  const p = pRes.data
  if (!p || !p.published) return fail('项目不存在或未发布')

  const sch = await db.collection(COL.schedules)
    .where({ projectId })
    .orderBy('date', 'asc')
    .get()

  const schedules = (sch.data || []).map(s => ({
    date: s.date,
    closed: !!s.closed,
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
    paused: !!p.paused,
    icon: p.icon,
    image: p.image,
    imageUrl: await resolveImage(p.image),
    intro: p.intro,
    introImages,                       // 已解析临时 URL 的介绍图集
    needReview: !!p.needReview,
    dailyLimit: p.dailyLimit || 1,
    advanceDays: p.advanceDays || 7,
    cutoff: p.cutoff || null,
    maxParty: p.maxParty || 2,
    subscribeNotify: !!p.subscribeNotify,
    openDays: p.openDays || [],
    useSlotTemplate: !!p.useSlotTemplate,
    slotTemplate: p.slotTemplate || []
  }

  return ok({ project, schedules })
}
