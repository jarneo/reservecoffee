// seedData — 一次性初始化首页文案 + 3 个种子项目（owner / 首次自动 owner 亦可）
const { db, COL, ok, fail, wxCtx, getRole, ensureOwner } = require('./lib')

const PROJECTS = [
  { name: '法兰绒深烘咖啡预约', icon: 'coffee', image: '法兰绒', intro: '每日限量法兰绒手冲深烘，安静的吧台座位。', needReview: false, dailyLimit: 1, advanceDays: 7 },
  { name: '清酒品鉴预约', icon: 'sake', image: '清酒', intro: '主理人带领的清酒小酌，每晚一场。', needReview: true, dailyLimit: 1, advanceDays: 14 },
  { name: '法兰绒研习社预约', icon: 'study', image: '研习', intro: '咖啡冲煮教学小班，需审核。', needReview: true, dailyLimit: 2, advanceDays: 30 }
]

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
  if (exist.total === 0) {
    for (const p of PROJECTS) {
      await db.collection(COL.projects).add({
        data: {
          ...p, published: true, paused: false, useSlotTemplate: false, slotTemplate: [],
          smsEnabled: false, smsNotice: '',
          openDays: [], ownerOpenid: OPENID, createdAt: Date.now(), updatedAt: Date.now()
        }
      })
      created++
    }
  }

  return ok({ homepage: !!hp.data, projectsCreated: created })
}
