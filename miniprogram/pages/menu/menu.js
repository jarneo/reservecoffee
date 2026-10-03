const { call } = require('../../utils/cloud')
const boot = require('../../utils/boot')
const { splitMasonry } = require('../../utils/masonry')
const { resolveRatios } = require('../../utils/imgRatio')

function stars(n) {
  const r = Math.round(Number(n) || 0)
  const c = Math.max(0, Math.min(5, r))
  return '★'.repeat(c) + '☆'.repeat(5 - c)
}

// 分列算法统一走 utils/masonry（按图片宽高比贪心分列，对齐两列底边），
// 不再在本页重复实现一份「按索引奇偶」的旧逻辑。

Page({
  data: { projectId: '', shopName: '', shopTag: '图片菜品 · 真实评价', products: [], colA: [], colB: [], booting: true },
  onLoad(q) {
    this._boot = boot(this, { timeout: 6000 })
    // 显式启用右上角「转发给好友」菜单（不调用则菜单置灰不可用）。
    // 朋友圈分享已从本页移除（onShareTimeline 删除），从根本上规避单页模式取数失败。
    wx.showShareMenu({ menus: ['shareAppMessage'] })
    this.setData({ projectId: q.projectId || '' })
    this.load()
  },
  load() {
    // 早退分支：不发起任何请求 → 必须显式关掉遮罩，否则永久白屏
    if (!this.data.projectId) {
      this._boot.close('noProject')
      return wx.showToast({ title: '缺少项目', icon: 'none' })
    }
    // 加载项目名作为菜单品牌头（对齐 menu-design.html 的店铺菜单 hero）
    this._boot.add(
      call('getProject', { projectId: this.data.projectId })
        .then(d => { if (d && d.project && d.project.name) this.setData({ shopName: d.project.name }) })
        .catch(() => {})
    )
    // listProducts 已按 status:'on' 过滤，即「在售菜品」
    this._boot.add(
      call('listProducts', { projectId: this.data.projectId })
        .then(d => {
          const products = (d.products || []).map(p => ({
            ...p, stars: stars(p.rating), priceText: '¥' + (p.price || 0)
          }))
          // 真实宽高比先解析，再分列：消除「等高估算→奇偶交错→末尾堆左」的错位
          resolveRatios(products).then(items => {
            const cols = splitMasonry(items)
            this.setData({ products: items, colA: cols.colA, colB: cols.colB }, () => {
              // 图片门：两列卡片图的真实张数在渲染回调里统计
              const n = items.filter(p => p.imageUrl).length
              this._boot.images(n).settle(1)
            })
          })
        })
        .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
    )
  },

  // bindload / binderror 共用：单张图失败也算完成，不阻塞整页
  onBootImg() {
    this._boot.image()
  },
  goProduct(e) {
    wx.navigateTo({ url: '/pages/product/product?productId=' + e.currentTarget.dataset.id })
  },

  // 转发给好友：分享菜品菜单（朋友圈分享已整体移除，规避单页模式取数失败）
  onShareAppMessage() {
    const name = this.data.shopName || '二曜路8号咖啡和清酒'
    return { title: name + ' · 店铺菜单', path: '/pages/menu/menu?projectId=' + (this.data.projectId || '') }
  }
})
