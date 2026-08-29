// getHomepage — 顾客端首页数据：首页配置 + 已发布且未删除项目列表 + 在售店铺菜单
const { db, COL, ok, fail, wxCtx, cloud, _, ymd, addDays, monthDay } = require('./lib')

async function resolveImage(fileId) {
  if (!fileId) return ''
  try {
    const res = await cloud.getTempFileURL({ fileList: [fileId] })
    const f = (res.fileList || [])[0]
    return (f && f.fileID) ? f.tempFileURL : ''
  } catch (e) { console.warn('[getHomepage] resolveImage failed:', e.message); return '' }
}

// 批量解析菜品主图临时 URL
async function resolveProducts(list) {
  if (!list.length) return list
  const ids = list.map(p => p.image).filter(Boolean)
  let urlMap = {}
  if (ids.length) {
    try {
      const res = await cloud.getTempFileURL({ fileList: ids })
      ;(res.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
    } catch (e) { console.warn('[getHomepage] getTempFileURL failed:', e.message) }
  }
  return list.map(p => ({ ...p, imageUrl: urlMap[p.image] || '' }))
}

// 场次是否已过预约截止（与顾客端 util.isSessionExpired 同源：仅取 cutoff.minutes / cutoff.mode）
function sessionExpired(dateStr, startStr, cutoff) {
  if (!cutoff || (cutoff.mode !== 'before' && cutoff.mode !== 'after') || !(Number(cutoff.minutes) > 0)) return false
  const [y, mo, d] = String(dateStr || '').split('-').map(Number)
  if (!y || !mo || !d) return false
  const a = String(startStr || '').split(':').map(Number)
  const mins = (isNaN(a[0]) ? 0 : a[0]) * 60 + (isNaN(a[1]) ? 0 : a[1])
  const start = new Date(y, mo - 1, d, Math.floor(mins / 60), mins % 60)
  const offset = Number(cutoff.minutes) * 60000
  const deadline = cutoff.mode === 'before' ? new Date(start.getTime() - offset) : new Date(start.getTime() + offset)
  return Date.now() >= deadline.getTime()
}

// 依据项目配置计算首页可预约状态与可约日期：
//   paused → 暂停；否则 可约日期 = openDays ∩ [今天, 今天+advanceDays] ∩ 有场次且未 closed ∩ 至少一场次可约(未暂停/有余额/未过期)
async function projectAvailability(p) {
  const today = ymd(new Date())
  const adv = Number(p.advanceDays) || 7
  const maxWin = addDays(adv)
  if (p.paused) return { bookStatus: 'paused', availableDates: [], availableCount: 0 }

  // 拉取该项目全部 schedules（分页规避云端默认上限），仅保留窗口内
  const raw = []
  let skip = 0
  while (true) {
    const res = await db.collection(COL.schedules).where({ projectId: p._id }).orderBy('date', 'asc').skip(skip).limit(100).get()
    const batch = res.data || []
    raw.push(...batch)
    if (batch.length < 100) break
    skip += 100
  }
  const closedSet = new Set()
  const sessMap = {}
  raw.forEach(s => {
    if (s.date >= today && s.date <= maxWin) {
      if (s.closed) closedSet.add(s.date)
      sessMap[s.date] = s.sessions || []
    }
  })

  const openSet = new Set(p.openDays || [])
  const cutoff = p.cutoff || null
  const dates = []
  openSet.forEach(d => {
    if (d < today || d > maxWin) return
    if (closedSet.has(d)) return
    const sess = sessMap[d]
    if (!sess || !sess.length) return
    const hasOpen = sess.some(x => !x.paused && (x.capacity - (x.booked || 0)) > 0 && !sessionExpired(d, x.start, cutoff))
    if (hasOpen) dates.push(d)
  })
  dates.sort()
  const MAX = 6
  const shown = dates.slice(0, MAX).map(d => ({ ymd: d, label: monthDay(d) }))
  return { bookStatus: dates.length ? 'ok' : 'none', availableDates: shown, availableCount: dates.length }
}

exports.main = async () => {
  const { OPENID } = wxCtx()
  // 首页文案（单文档 _id='homepage'）
  const hp = await db.collection(COL.homepage).doc('homepage').get().catch(() => ({ data: null }))
  const homepage = hp.data || { logo: '二曜路8号咖啡和清酒', tag: 'SLOW COFFEE · 预约制', heroImage: '', intro: '' }

  // 已发布且未删除的项目
  const proj = await db.collection(COL.projects).where({ published: true, deleted: _.neq(true) }).orderBy('createdAt', 'asc').get()
  const projects = await Promise.all((proj.data || []).map(async p => {
    const av = await projectAvailability(p)
    return {
      _id: p._id,
      name: p.name,
      icon: p.icon,
      image: p.image,
      imageUrl: '',
      intro: p.intro,
      needReview: !!p.needReview,
      bookStatus: av.bookStatus,
      availableDates: av.availableDates,
      availableCount: av.availableCount
    }
  }))

  // 解析首个可见项目的封面为临时 URL（顾客首页头图）
  if (projects.length && projects[0].image) {
    projects[0].imageUrl = await resolveImage(projects[0].image)
  }

  // 店铺菜单：在售菜品（按可见项目范围），含评价数
  let products = []
  const projectIds = projects.map(p => p._id)
  if (projectIds.length) {
    const pRes = await db.collection(COL.products)
      .where({ projectId: _.in(projectIds), status: 'on' })
      .orderBy('sort', 'asc').get()
    products = await resolveProducts(pRes.data || [])

    const productIds = products.map(p => p._id)
    if (productIds.length) {
      const rRes = await db.collection(COL.reviews).where({ productId: _.in(productIds), status: 'normal' }).get()
      const cnt = {}
      ;(rRes.data || []).forEach(r => { cnt[r.productId] = (cnt[r.productId] || 0) + 1 })
      products = products.map(p => ({
        _id: p._id, name: p.name, price: p.price, desc: p.desc,
        image: p.image, imageUrl: p.imageUrl, reviewCount: cnt[p._id] || 0
      }))
    } else {
      products = products.map(p => ({ ...p, reviewCount: 0 }))
    }
  }

  // 解析首页主图（店铺主图）为临时 URL，供顾客首页头图展示
  if (homepage.heroImage) {
    try { homepage.heroImageUrl = await resolveImage(homepage.heroImage) } catch (e) { homepage.heroImageUrl = '' }
  }
  console.log('[getHomepage] openid=', OPENID, 'projects=', projects.length, 'products=', products.length)
  return ok({ homepage, projects, products })
}
