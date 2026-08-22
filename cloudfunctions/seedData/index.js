// seedData — 一次性初始化首页文案 + 3 个种子项目（owner / 首次自动 owner 亦可）
const { db, COL, ok, fail, wxCtx, getRole, ensureOwner } = require('./lib')

const PROJECTS = [
  { name: '法兰绒深烘咖啡预约', icon: 'coffee', image: '法兰绒', intro: '每日限量法兰绒手冲深烘，安静的吧台座位。', needReview: false, dailyLimit: 1, advanceDays: 7 },
  { name: '清酒品鉴预约', icon: 'sake', image: '清酒', intro: '主理人带领的清酒小酌，每晚一场。', needReview: true, dailyLimit: 1, advanceDays: 14 },
  { name: '法兰绒研习社预约', icon: 'study', image: '研习', intro: '咖啡冲煮教学小班，需审核。', needReview: true, dailyLimit: 2, advanceDays: 30 }
]

// 尽量自动创建集合（SDK 支持时）；不支持则静默跳过，需到控制台手动创建 products / reviews
async function ensureCollection(name) {
  try {
    if (typeof db.createCollection === 'function') await db.createCollection(name)
  } catch (e) { console.warn('[seedData] createCollection skipped:', name, e.message) }
}

exports.main = async () => {
  const { OPENID } = wxCtx()
  await ensureOwner(OPENID)
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可初始化数据')

  // 首页文案（若不存在）
  const hp = await db.collection(COL.homepage).doc('homepage').get().catch(() => ({ data: null }))
  if (!hp.data) {
    await db.collection(COL.homepage).add({
      data: {
        _id: 'homepage',
        logo: '二曜路8号咖啡和清酒',
        tag: 'SLOW COFFEE · 预约制',
        heroImage: '',
        intro: '一家以法兰绒滴滤与清酒品鉴为特色的预约制咖啡空间。请选择下方项目开始预约。',
        updatedAt: Date.now()
      }
    })
  }

  // 项目（若不存在）
  const exist = await db.collection(COL.projects).count()
  let created = 0
  let firstProjectId = null
  if (exist.total === 0) {
    for (const p of PROJECTS) {
      const add = await db.collection(COL.projects).add({
        data: {
          ...p, published: true, paused: false, useSlotTemplate: false, slotTemplate: [],
          smsEnabled: false,
          openDays: [], ownerOpenid: OPENID, createdAt: Date.now(), updatedAt: Date.now()
        }
      })
      if (!firstProjectId) firstProjectId = add._id
      created++
    }
  }

  // 菜单/评价集合（若 SDK 支持则自动创建，否则请在控制台手动创建 products / reviews）
  await ensureCollection(COL.products)
  await ensureCollection(COL.reviews)

  // 演示菜品（仅首次，绑定到首个项目）
  if (exist.total === 0 && firstProjectId) {
    const PRODUCT_SEED = [
      { name: '法兰绒手冲深烘', price: 38, desc: '法兰绒滤布缓慢滴滤，巧克力与坚果尾韵。', sort: 0, status: 'on' },
      { name: '清酒小酌拼盘', price: 88, desc: '三款当季清酒搭配佐酒小食。', sort: 1, status: 'on' },
      { name: '咖啡研习课', price: 128, desc: '主理人带领下的一对一冲煮教学。', sort: 2, status: 'off' }
    ]
    for (const pr of PRODUCT_SEED) {
      await db.collection(COL.products).add({
        data: {
          projectId: firstProjectId, name: pr.name, image: '',
          price: pr.price, desc: pr.desc, status: pr.status, sort: pr.sort,
          rating: 0, ratingCount: 0, createdAt: Date.now()
        }
      })
    }
  }

  return ok({ homepage: !!hp.data, projectsCreated: created })
}
