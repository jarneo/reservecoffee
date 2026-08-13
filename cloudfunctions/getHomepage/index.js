// getHomepage — 顾客端首页数据：首页配置 + 已发布项目列表
const { db, COL, ok, fail, wxCtx } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  // 首页文案（单文档 _id='homepage'）
  const hp = await db.collection(COL.homepage).doc('homepage').get().catch(() => ({ data: null }))
  const homepage = hp.data || { logo: '二曜路8号咖啡和清酒', tag: 'SLOW COFFEE · 预约制', heroImage: '', intro: '' }

  // 已发布项目
  const proj = await db.collection(COL.projects).where({ published: true }).orderBy('createdAt', 'asc').get()
  const projects = (proj.data || []).map(p => ({
    _id: p._id,
    name: p.name,
    icon: p.icon,
    image: p.image,
    intro: p.intro,
    needReview: !!p.needReview
  }))

  console.log('[getHomepage] openid=', OPENID, 'projects=', projects.length)
  return ok({ homepage, projects })
}
