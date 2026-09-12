const { call } = require('../../utils/cloud')
const app = getApp()

// 双栏瀑布流：按索引奇偶拆成左右两列，两列各自独立纵向堆叠，互不强制行对齐，消除同行高度差造成的留白
function splitCols(list) {
  const colA = [], colB = []
  ;(list || []).forEach((it, i) => { (i % 2 === 0 ? colA : colB).push(it) })
  return { colA, colB }
}

Page({
  data: {
    homepage: {}, projects: [], products: [], featured: null, role: 'none'
  },

  onShow() {
    this.load()
    // 重新拉取角色，避免 onLaunch 异步未返回时拿到过期的 'none' 导致按钮不显示
    app.refreshRole().then(r => {
      this.setData({ role: (r && r.role) || 'none' })
    })
  },

  load() {
    call('getHomepage')
      .then(d => {
        const products = d.products || []
        const cols = splitCols(products)
        this.setData({
          homepage: d.homepage || {},
          projects: d.projects || [],
          products,
          colA: cols.colA,
          colB: cols.colB,
          featured: (d.projects && d.projects[0]) || null
        })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  goBooking(e) {
    wx.navigateTo({ url: '/pages/booking/booking?projectId=' + e.currentTarget.dataset.id })
  },

  goProduct(e) {
    wx.navigateTo({ url: '/pages/product/product?productId=' + e.currentTarget.dataset.id })
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/hub/hub' })
  },

  // 转发给好友 / 分享朋友圈：分享店铺首页
  onShareAppMessage() {
    const hp = this.data.homepage || {}
    return {
      title: hp.logo || '二曜路8号咖啡和清酒',
      path: '/pages/index/index'
    }
  },
  onShareTimeline() {
    const hp = this.data.homepage || {}
    return {
      title: hp.logo || '二曜路8号咖啡和清酒',
      query: ''
    }
  }
})
