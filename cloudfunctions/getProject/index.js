// getProject — 单项目详情 + 全部日期场次（顾客端选日期/场次用）
const { db, COL, ok, fail, cloud, notifyWindowCfg, loadAiSwitch, thumb } = require('./lib')

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
  // 介绍图在 booking 页全宽展示（.intro-img width:100%），750x 足够
  return list
    .map(it => ({ ...it, url: thumb(urlMap[it.fileId] || '', 'cover') }))
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

// 展开关联项目：按 relatedProjectIds 原序返回精简字段（仅已发布），用于顾客端「关联项目」模块
// 无效 / 未发布 / 自引用的 ID 自动跳过，保证展示稳定
async function resolveRelated(ids) {
  if (!Array.isArray(ids) || !ids.length) return []
  const docs = await Promise.all(
    ids.map(id => db.collection(COL.projects).doc(id).get().then(r => r.data).catch(() => null))
  )
  const map = {}
  docs.forEach(d => { if (d) map[d._id] = d })
  const valid = ids.map(id => map[id]).filter(d => d && d.published)
  const fileIds = valid.map(d => d.iconFileId).filter(Boolean)
  let urlMap = {}
  if (fileIds.length) {
    try {
      const res = await cloud.getTempFileURL({ fileList: fileIds })
      ;(res.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[getProject] resolveRelated getTempFileURL failed:', e.message) }
  }
  return valid.map(d => ({
    _id: d._id,
    name: d.name,
    intro: (d.intro || '').slice(0, 60),
    iconUrl: thumb(urlMap[d.iconFileId] || '', 'icon')
  }))
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
  const relatedProjects = await resolveRelated(p.relatedProjectIds || [])

  // 通知时间窗配置：顾客端据此按预约时间轴裁剪「本次该申请哪几个订阅模板」（≤3，一次弹窗）
  const swRes2 = await db.collection('config').doc('smsnotify').get().catch(() => ({ data: null }))
  const notifyCfg = notifyWindowCfg(swRes2 && swRes2.data)

  const project = {
    _id: p._id,
    name: p.name,
    paused: !!p.paused,
    icon: p.icon,
    iconUrl: thumb(await resolveImage(p.iconFileId), 'icon'),
    image: p.image,
    imageUrl: thumb(await resolveImage(p.image), 'cover'),
    intro: p.intro,
    introImages,                       // 已解析临时 URL 的介绍图集
    relatedProjects,                    // 关联项目（已展开精简字段，按原序）
    needReview: !!p.needReview,
    dailyLimit: p.dailyLimit || 1,
    advanceDays: p.advanceDays || 7,
    cutoff: p.cutoff || null,
    maxParty: p.maxParty || 2,
    subscribeNotify: !!p.subscribeNotify,
    smsEnabled: !!p.smsEnabled,
    showSeatInfo: p.showSeatInfo !== false,
    // 预约成功结果页的默认菜单分类（_id 字符串，空 = 全部）；结果页读到后仍会校验有效性
    resultCategoryId: p.resultCategoryId || '',
    fields: p.fields || ['name', 'phone'],
    openDays: p.openDays || [],
    useSlotTemplate: !!p.useSlotTemplate,
    slotTemplate: p.slotTemplate || []
  }

  return ok({ project, schedules, notifyCfg, aiEnabled: await loadAiSwitch(db).catch(() => true) })
}
