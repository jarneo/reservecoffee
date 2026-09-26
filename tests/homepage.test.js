// tests/homepage.test.js — getHomepage 云函数「并行化 + 图片缩略图」改造的回归测试
//
// 目的：改造把原来的串行链压成 3 个并行阶段、把 schedules 的 N 次查询合并成 1 次，
// 这类改动最容易「悄悄改语义」。本测试用同一份 mock 数据分别跑「改造前」与「改造后」
// 的实现，逐字段深比较，确保输出完全一致；同时统计 DB / getTempFileURL 调用次数，
// 量化并行化的收益。
//
// 运行：node tests/homepage.test.js
// ⚠️ 依赖 tests/stubs/wx-server-sdk 桩，通过 NODE_PATH 注入全局模块解析路径。
//    桩**必须**放在 tests/ 下而不是 cloudfunctions/<fn>/node_modules/ ——
//    后者会被云函数部署一起打包上传，覆盖真实的 wx-server-sdk，直接把线上函数搞挂。

const path = require('path')
const assert = require('assert')

// 让任意位置的 require('wx-server-sdk') 都解析到桩
process.env.NODE_PATH = path.join(__dirname, 'stubs')
require('module').Module._initPaths()

const FN_DIR = path.join(__dirname, '..', 'cloudfunctions', 'getHomepage')
process.chdir(FN_DIR)

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)) }

// ─────────────────────────── mock 数据 ───────────────────────────
// ⚠️ 顺序很重要：桩模块在加载时就捕获 global.__MOCK_DB__ 的引用，
// 所以必须先赋值再 require，否则桩拿到的是空对象。
function ymdLocal(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
const TODAY = ymdLocal(new Date())
const D = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymdLocal(d) }

global.__MOCK_DB__ = {
  // ⚠️ 必须用 COL 里的真实集合名：首页文档存在 config_homepage 而非 homepage
  config_homepage: [{ _id: 'homepage', logo: '二曜路8号咖啡和清酒', heroImage: 'cloud://x/homepage/hero.jpg' }],
  projects: [
    { _id: 'p1', name: '法兰绒深烘', published: true, createdAt: 1, iconFileId: 'cloud://x/projects/icon1.jpg',
      image: 'cloud://x/projects/cover1.jpg', advanceDays: 7, openDays: [TODAY, D(1), D(2)], paused: false },
    { _id: 'p2', name: '清酒品鉴', published: true, createdAt: 2, iconFileId: 'cloud://x/projects/icon2.jpg',
      image: 'cloud://x/projects/cover2.jpg', advanceDays: 14, openDays: [D(3), D(10)], paused: false },
    { _id: 'p3', name: '已下架', published: false, createdAt: 3, advanceDays: 7, openDays: [TODAY] }
  ],
  schedules: [
    { projectId: 'p1', date: TODAY, closed: false, sessions: [{ id: 's1', start: '10:00', capacity: 4, booked: 1 }] },
    { projectId: 'p1', date: D(1), closed: false, sessions: [{ id: 's2', start: '14:00', capacity: 2, booked: 2 }] }, // 满员
    { projectId: 'p1', date: D(2), closed: true,  sessions: [{ id: 's3', start: '14:00', capacity: 2, booked: 0 }] }, // 关闭
    { projectId: 'p2', date: D(3), closed: false, sessions: [{ id: 's4', start: '19:00', capacity: 6, booked: 0 }] },
    { projectId: 'p2', date: D(10), closed: false, sessions: [] },   // 无场次
    { projectId: 'p1', date: '2020-01-01', closed: false, sessions: [{ id: 'old', start: '10:00', capacity: 9, booked: 0 }] } // 窗口外
  ],
  products: [
    { _id: 'r1', projectId: 'p1', name: '手冲', price: 38, status: 'on', sort: 1, image: 'cloud://x/products/a.jpg' },
    { _id: 'r2', projectId: 'p1', name: '拿铁', price: 32, status: 'on', sort: 2, image: 'cloud://x/products/b.jpg' },
    { _id: 'r3', projectId: 'p2', name: '清酒', price: 88, status: 'on', sort: 3, image: '' },   // 无图
    { _id: 'r4', projectId: 'p1', name: '下架品', price: 10, status: 'off', sort: 4, image: 'cloud://x/products/c.jpg' }
  ],
  reviews: [
    { productId: 'r1', status: 'normal' },
    { productId: 'r1', status: 'normal' },
    { productId: 'r2', status: 'hidden' }   // 不计入
  ],
  config: [], config_ai: []
}

const cloud = require('wx-server-sdk')          // → tests/stubs 下的桩
const { ymd, addDays, monthDaySlash, thumb, THUMB_SPEC } = require(path.join(FN_DIR, 'lib'))

// ───────────────── 改造前的实现（原样保留，作为基准）─────────────────
const { db, COL, ok: okRes, loadAiSwitch, wxCtx } = require(path.join(FN_DIR, 'lib'))
const _ = db.command
const MENU_LIMIT = 10

function sessionExpired(dateStr, startStr, cutoff) {
  if (!cutoff || (cutoff.mode !== 'before' && cutoff.mode !== 'after') || !(Number(cutoff.minutes) > 0)) return false
  const [y, mo, d] = String(dateStr || '').split('-').map(Number)
  if (!y || !mo || !d) return false
  const a = String(startStr || '').split(':').map(Number)
  const mins = (isNaN(a[0]) ? 0 : a[0]) * 60 + (isNaN(a[1]) ? 0 : a[1]) * 60
  const start = new Date(y, mo - 1, d, Math.floor(mins / 60), mins % 60)
  const offset = Number(cutoff.minutes) * 60000
  const deadline = cutoff.mode === 'before' ? new Date(start.getTime() - offset) : new Date(start.getTime() + offset)
  return Date.now() >= deadline.getTime()
}
async function oldResolveImage(fileId) {
  if (!fileId) return ''
  const res = await cloud.getTempFileURL({ fileList: [fileId] })
  const f = (res.fileList || [])[0]
  return (f && f.fileID) ? f.tempFileURL : ''
}
async function oldResolveProducts(list) {
  if (!list.length) return list
  const ids = list.map(p => p.image).filter(Boolean)
  let urlMap = {}
  if (ids.length) {
    const res = await cloud.getTempFileURL({ fileList: ids })
    ;(res.fileList || []).forEach(f => { if (f.fileID) urlMap[f.fileID] = f.tempFileURL })
  }
  return list.map(p => ({ ...p, imageUrl: urlMap[p.image] || '' }))
}
async function oldProjectAvailability(p) {
  const today = ymd(new Date())
  const adv = Number(p.advanceDays) || 7
  const maxWin = addDays(adv)
  if (p.paused) return { bookStatus: 'paused', availableDates: [], availableCount: 0 }
  const raw = []
  let skip = 0
  while (true) {
    const res = await db.collection(COL.schedules).where({ projectId: p._id }).orderBy('date', 'asc').skip(skip).limit(100).get()
    const batch = res.data || []
    raw.push(...batch)
    if (batch.length < 100) break
    skip += 100
  }
  const closedSet = new Set(), sessMap = {}
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
  return { bookStatus: dates.length ? 'ok' : 'none', availableDates: dates.slice(0, 6).map(d => ({ ymd: d, label: monthDaySlash(d) })), availableCount: dates.length }
}
async function oldMain() {
  const hp = await db.collection(COL.homepage).doc('homepage').get().catch(() => ({ data: null }))
  const homepage = hp.data || {}
  const proj = await db.collection(COL.projects).where({ published: true, deleted: _.neq(true) }).orderBy('createdAt', 'asc').get()
  const projects = await Promise.all((proj.data || []).map(async p => {
    const av = await oldProjectAvailability(p)
    return { _id: p._id, name: p.name, icon: p.icon, iconUrl: await oldResolveImage(p.iconFileId),
      image: p.image, imageUrl: '', intro: p.intro, needReview: !!p.needReview,
      bookStatus: av.bookStatus, availableDates: av.availableDates, availableCount: av.availableCount }
  }))
  if (projects.length && projects[0].image) projects[0].imageUrl = await oldResolveImage(projects[0].image)
  let products = []
  const projectIds = projects.map(p => p._id)
  if (projectIds.length) {
    const pRes = await db.collection(COL.products).where({ projectId: _.in(projectIds), status: 'on' }).orderBy('sort', 'asc').limit(MENU_LIMIT).get()
    products = await oldResolveProducts(pRes.data || [])
    const productIds = products.map(p => p._id)
    if (productIds.length) {
      const rRes = await db.collection(COL.reviews).where({ productId: _.in(productIds), status: 'normal' }).get()
      const cnt = {}
      ;(rRes.data || []).forEach(r => { cnt[r.productId] = (cnt[r.productId] || 0) + 1 })
      products = products.map(p => ({ _id: p._id, name: p.name, price: p.price, desc: p.desc, image: p.image, imageUrl: p.imageUrl, reviewCount: cnt[p._id] || 0 }))
    } else {
      products = products.map(p => ({ ...p, reviewCount: 0 }))
    }
  }
  if (homepage.heroImage) { try { homepage.heroImageUrl = await oldResolveImage(homepage.heroImage) } catch (e) { homepage.heroImageUrl = '' } }
  const aiEnabled = await loadAiSwitch(db).catch(() => true)
  return okRes({ homepage, projects, products, aiEnabled })
}

// ─────────────────────────── 开跑 ───────────────────────────
const NEW = require(path.join(FN_DIR, 'index.js'))

// 把 URL 里的缩略图参数剥掉再比较：这是本次改造唯一的预期差异
const strip = o => JSON.parse(JSON.stringify(o).replace(/&imageMogr2\/[^"'\\]*/g, ''))

async function run() {
  console.log('\n──── A. thumb 缩略图工具 ────')
  const U = 'https://636c-x.tcb.qcloud.la/a.jpg?sign=abc&t=123'
  ok(thumb(U, 'card') === U + '&imageMogr2/thumbnail/400x/quality/72', '云存储链接追加参数（已有 ? → 用 &）')
  ok(thumb('https://636c-x.tcb.qcloud.la/a.jpg', 'card') === 'https://636c-x.tcb.qcloud.la/a.jpg?imageMogr2/thumbnail/400x/quality/72', '无 query 时用 ?')
  ok(thumb('', 'card') === '', '空值 → 空')
  ok(thumb(null, 'card') === '', 'null → 空')
  ok(thumb('https://other.cdn.com/a.jpg', 'card') === 'https://other.cdn.com/a.jpg', '非云存储域名 → 原样返回')
  ok(thumb(thumb(U, 'card'), 'card') === thumb(U, 'card'), '幂等：已追加过不再重复追加')
  ok(thumb(U, 'nope') === U, '未知档位 → 原样返回（不擅自处理）')
  ok(Object.keys(THUMB_SPEC).length === 6, '6 个档位全部定义')

  console.log('\n──── B. 新旧实现输出一致性（剥掉缩略图参数后深比较）────')
  global.__CALL_LOG__.length = 0
  const oldR = await oldMain()
  const oldCalls = global.__CALL_LOG__.slice()

  global.__CALL_LOG__.length = 0
  const newR = await NEW.main()
  const newCalls = global.__CALL_LOG__.slice()

  ok(oldR.code === 0 && newR.code === 0, '两者都返回 code=0')
  try {
    assert.deepStrictEqual(strip(newR.data), strip(oldR.data))
    ok(true, 'homepage / projects / products / aiEnabled 逐字段完全一致 ✅')
  } catch (e) {
    ok(false, '输出不一致：' + String(e.message).split('\n').slice(0, 12).join('\n      '))
  }

  console.log('\n──── C. 业务语义抽查 ────')
  const p1 = newR.data.projects.find(p => p._id === 'p1')
  const p2 = newR.data.projects.find(p => p._id === 'p2')
  ok(newR.data.projects.length === 2, '只返回已发布项目（p3 已下架被过滤）')
  ok(p1.availableCount === 1, 'p1 仅 1 天可约（D1 满员、D2 关闭各被排除）')
  ok(p2.availableCount === 1, 'p2 仅 D3 可约（D10 无场次被排除）')
  ok(p1.imageUrl !== '' && newR.data.projects[1].imageUrl === '', '仅首个项目的封面被解析为首页头图')
  const r1 = newR.data.products.find(p => p._id === 'r1')
  const r2 = newR.data.products.find(p => p._id === 'r2')
  ok(newR.data.products.length === 3, '只返回在售菜品（r4 下架被过滤）')
  ok(r1.reviewCount === 2 && r2.reviewCount === 0, '评价数正确（r1=2，r2 的评价是 hidden 不计入）')
  ok(r3HasNoImg(newR.data.products), '无图菜品 imageUrl 为空字符串，不是 undefined')
  ok(newR.data.homepage.heroImageUrl.indexOf('imageMogr2/thumbnail/750x') > 0, '头图走 hero 档（750x）')

  console.log('\n──── D. 调用次数（并行化收益）────')
  const count = (log, pred) => log.filter(pred).length
  const oldSched = count(oldCalls, c => c.name === 'schedules')
  const newSched = count(newCalls, c => c.name === 'schedules')
  const oldTmp = count(oldCalls, c => c.getTempFileURL !== undefined)
  const newTmp = count(newCalls, c => c.getTempFileURL !== undefined)
  console.log(`      schedules 查询：改造前 ${oldSched} 次 → 改造后 ${newSched} 次`)
  console.log(`      getTempFileURL：改造前 ${oldTmp} 次 → 改造后 ${newTmp} 次`)
  ok(newSched === 1, 'schedules 合并为 1 次批量查询（改造前每个项目各查一次）')
  ok(newSched < oldSched, `schedules 调用次数下降（${oldSched} → ${newSched}）`)
  ok(newTmp <= 2, `getTempFileURL 合并到 ≤2 次（改造前 ${oldTmp} 次）`)
  ok(newTmp < oldTmp, `getTempFileURL 调用次数下降（${oldTmp} → ${newTmp}）`)

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`)
  process.exit(fail ? 1 : 0)
}

function r3HasNoImg(list) {
  const r3 = list.find(p => p._id === 'r3')
  return r3 && r3.imageUrl === ''
}

run().catch(e => { console.error('测试崩溃:', e); process.exit(1) })
