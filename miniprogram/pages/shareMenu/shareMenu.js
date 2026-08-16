// pages/shareMenu/shareMenu — 公众号专属：店铺菜单 + 顾客评价（只读，不在小程序内导航出现）
const { call } = require('../../utils/cloud')

function stars(n) {
  const r = Math.round(Number(n) || 0)
  const c = Math.max(0, Math.min(5, r))
  return '★'.repeat(c) + '☆'.repeat(5 - c)
}

Page({
  data: {
    shop: { logo: '店铺菜单', tag: '', intro: '' },
    products: [],
    reviews: []
  },
  onLoad(q) {
    // projectId 可选：指定某预约项目的菜单；缺省展示全店已发布项目
    this.setData({ projectId: q.projectId || '' })
    this.load()
  },
  load() {
    call('getMenu', { projectId: this.data.projectId })
      .then(d => {
        const products = (d.products || []).map(p => ({
          ...p,
          stars: stars(p.rating),
          priceText: '¥' + (p.price || 0),
          ratingText: (p.ratingCount ? Number(p.rating || 0).toFixed(1) : '—')
        }))
        const reviews = (d.reviews || []).map(r => ({ ...r, stars: stars(r.rating) }))
        this.setData({
          shop: d.shop || this.data.shop,
          products,
          reviews
        })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  }
})
