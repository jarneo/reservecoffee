// getHomepage — 顾客端首页数据：首页配置 + 已发布且未删除项目列表 + 在售店铺菜单
const { db, COL, ok, fail, wxCtx, cloud, _, ymd, addDays, monthDaySlash, loadAiSwitch, thumb } = require('./lib')

// 首页店铺菜单最多展示数量（按 sort 升序取前 N 个）；分类切换时由 listProducts 取该类目全量
const MENU_LIMIT = 15

// 批量把 cloud fileID 解析为临时下载链接（一次调用换回全部，避免 N 次网络往返）
async function resolveUrls(fileIds) {
  const ids = (fileIds || []).filter(Boolean)
  const map = {}
  if (!ids.length) return map
  try {
    const res = await cloud.getTempFileURL({ fileList: ids })
    ;(res.fileList || []).forEach(f => { if (f && f.fileID && f.tempFileURL) map[f.fileID] = f.tempFileURL })
  } catch (e) { console.warn('[getHomepage] getTempFileURL failed:', e.message) }
  return map
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

// 一次性拉取所有项目在 [今天, 今天+maxAdvanceDays] 窗口内的 schedules 并按 projectId 分组。
// ⚠️ 原来是「每个项目各查一次 + 各自 while 分页」= N 次 DB 往返；这里合并为 1 次查询（保留分页），
// 并用 date 范围条件把返回的文档量从「全部历史」压到「只含窗口内」。
async function loadSchedules(projectIds, today, globalMaxWin) {
  const map = {}
  if (!projectIds || !projectIds.length) return map
  let skip = 0
  while (true) {
    const res = await db.collection(COL.schedules)
      .where({ projectId: _.in(projectIds), date: _.gte(today).and(_.lte(globalMaxWin)) })
      .orderBy('date', 'asc').skip(skip).limit(100).get()
    const batch = res.data || []
    batch.forEach(s => { (map[s.projectId] = map[s.projectId] || []).push(s) })
    if (batch.length < 100) break
    skip += 100
  }
  return map
}

// 依据项目配置计算首页可预约状态与可约日期：
//   paused → 暂停；否则 可约日期 = openDays ∩ [今天, 今天+advanceDays] ∩ 有场次且未 closed ∩ 至少一场次可约(未暂停/有余额/未过期)
// 纯计算，不再访问数据库（schedules 由 loadSchedules 提前批量载入）
function projectAvailability(p, schedMap, today) {
  const adv = Number(p.advanceDays) || 7
  const maxWin = addDays(adv)
  if (p.paused) return { bookStatus: 'paused', availableDates: [], availableCount: 0 }

  const closedSet = new Set()
  const sessMap = {}
  ;(schedMap[p._id] || []).forEach(s => {
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
  const shown = dates.slice(0, MAX).map(d => ({ ymd: d, label: monthDaySlash(d) }))
  return { bookStatus: dates.length ? 'ok' : 'none', availableDates: shown, availableCount: dates.length }
}

exports.main = async () => {
  const { OPENID } = wxCtx()
  // 首页文案（单文档 _id='homepage'）
  const today = ymd(new Date())

  // ── 阶段 1：三个互不依赖的查询并行发起（原来是三次串行 await）──
  const [hp, proj, aiEnabled, catRes] = await Promise.all([
    db.collection(COL.homepage).doc('homepage').get().catch(() => ({ data: null })),
    db.collection(COL.projects).where({ published: true, deleted: _.neq(true) }).orderBy('createdAt', 'asc').get(),
    // AI 智能预约总开关（缺省开）：前端用它控制首页浮窗与 AI 入口显隐（详见 ai-reserve-spec.md §15）
    loadAiSwitch(db).catch(() => true),
    // 菜单分类（全局类目），供首页分类切换栏使用
    db.collection(COL.categories).orderBy('sort', 'asc').get().catch(() => ({ data: [] }))
  ])
  const homepage = hp.data || { logo: '二曜路8号咖啡和清酒', tag: 'SLOW COFFEE · 预约制', heroImage: '', intro: '' }
  const projList = proj.data || []
  const projectIds = projList.map(p => p._id)
  const categories = (catRes && catRes.data) || []

  // 批量查 schedules 的窗口上界：取所有项目 advanceDays 的最大值，保证一次查询覆盖每个项目的窗口
  const globalMaxWin = projList.reduce((m, p) => {
    const w = addDays(Number(p.advanceDays) || 7)
    return w > m ? w : m
  }, addDays(7))

  // ── 阶段 2：schedules / 菜品 / 图片链接 三条并行（原本是串行 + 逐项 await）──
  // 一次性收集阶段 1 已拿到的所有 fileID，合并成单次 getTempFileURL 调用
  const needIds = []
  projList.forEach(p => { if (p.iconFileId) needIds.push(p.iconFileId) })
  if (projList.length && projList[0].image) needIds.push(projList[0].image)
  if (homepage.heroImage) needIds.push(homepage.heroImage)

  const [schedMap, pRes, urlMap] = await Promise.all([
    loadSchedules(projectIds, today, globalMaxWin),
    projectIds.length
      ? db.collection(COL.products)
          .where({ projectId: _.in(projectIds), status: 'on' })
          .orderBy('sort', 'asc').limit(MENU_LIMIT).get()
      : Promise.resolve({ data: [] }),
    resolveUrls(needIds)
  ])

  // 项目可约状态为纯计算（schedules 已在阶段 2 批量载入）；图标/封面一律走缩略图
  const projects = projList.map((p, i) => {
    const av = projectAvailability(p, schedMap, today)
    return {
      _id: p._id,
      name: p.name,
      icon: p.icon,
      iconUrl: thumb(urlMap[p.iconFileId] || '', 'icon'),
      image: p.image,
      // 仅首个可见项目的封面作为首页头图（与原逻辑一致）
      imageUrl: i === 0 ? thumb(urlMap[p.image] || '', 'cover') : '',
      intro: p.intro,
      needReview: !!p.needReview,
      bookStatus: av.bookStatus,
      availableDates: av.availableDates,
      availableCount: av.availableCount
    }
  })
  if (homepage.heroImage) homepage.heroImageUrl = thumb(urlMap[homepage.heroImage] || '', 'hero')

  // ── 阶段 3：评价数 + 菜品图链接 并行 ──
  const rawProducts = pRes.data || []
  const productIds = rawProducts.map(p => p._id)
  const [rRes, productUrlMap] = await Promise.all([
    productIds.length
      ? db.collection(COL.reviews).where({ productId: _.in(productIds), status: 'normal' }).get()
      : Promise.resolve({ data: [] }),
    resolveUrls(rawProducts.map(p => p.image))
  ])

  const cnt = {}
  ;(rRes.data || []).forEach(r => { cnt[r.productId] = (cnt[r.productId] || 0) + 1 })
  const products = rawProducts.map(p => ({
    _id: p._id, name: p.name, price: p.price, desc: p.desc,
    image: p.image, categoryId: p.categoryId || '',
    // ⚠️ ratio 必须显式带出：这是**字段投影**（不是 {...p} 展开），漏了就丢。
    // 前端首页瀑布流用它估算卡片高度、对齐两列底边；0/缺失时前端回退默认 1.30。
    ratio: Number(p.ratio) > 0 ? Number(p.ratio) : 0,
    imageUrl: thumb(productUrlMap[p.image] || '', 'card'),
    reviewCount: cnt[p._id] || 0
  }))

  console.log('[getHomepage] openid=', OPENID, 'projects=', projects.length, 'products=', products.length, 'categories=', categories.length)
  return ok({ homepage, projects, products, aiEnabled, categories })
}
