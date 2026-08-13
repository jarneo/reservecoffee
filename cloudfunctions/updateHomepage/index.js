// updateHomepage — 保存首页配置（仅 owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可配置首页')

  const data = {
    logo: (event.logo || '二曜路8号咖啡和清酒').toString().slice(0, 30),
    tag: (event.tag || 'SLOW COFFEE · 预约制').toString().slice(0, 40),
    heroImage: event.heroImage || '',
    intro: (event.intro || '').toString().slice(0, 500),
    updatedAt: Date.now()
  }
  await db.collection(COL.homepage).doc('homepage').set({ data })
  return ok({ updated: true })
}
