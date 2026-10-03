const { call } = require('../../utils/cloud')
const boot = require('../../utils/boot')
const { splitMasonry } = require('../../utils/masonry')
const { resolveRatios } = require('../../utils/imgRatio')
const app = getApp()

// ── 首页数据本地缓存（SWR：先用缓存秒开，再后台静默更新）───────────────────
// 首页数据是低频变动的（首页文案 / 项目列表 / 在售菜单），把它缓存下来后，
// 二次进入可以立刻渲染、只等图片门，不必再等一次云函数往返。
// CACHE_VER 用于数据结构变更时作废旧缓存，避免读到旧结构。
const CACHE_KEY = 'homepageCacheV1'
// ⚠️ 数据结构变更必须自增，否则老缓存命中后走不到新逻辑：
// 4 = 修正瀑布流卡片高度公式（列宽×ratio，此前误写成列宽÷ratio）+ 存量菜品已回填真实 ratio。
//     老缓存里的菜品无 ratio，只会走默认兜底估算，底边必然偏差，故作废旧缓存。
const CACHE_VER = 4
const CACHE_TTL = 10 * 60 * 1000   // 10 分钟；超时后回退到「等网络」的正常流程

// 双列瀑布流：按图片宽高比**贪心分列**（总是把卡片给当前较矮的一列），
// 两列底边偏差被压到「一张卡以内」且图片保持原始构图。
// ⚠️ 早期实现是「按索引奇偶拆两列」（0,2,4…进左列），不看卡片高度 ——
//    15 项时必然左 8 右 7，底边差一整张图，视觉上就是「序号 11 和 13 都在左边」。
//    现改为按高度贪心；高度预估逻辑与兜底见 utils/masonry.js。
// 保留旧名以免遗漏调用点：调用处直接改名 splitMasonry。

Page({
  data: {
    homepage: {}, projects: [], products: [], featured: null, role: 'none',
    // 首帧即需声明的字段：colA/colB/aiEnabled 原先未声明，首帧绑定 undefined 会先渲染 0 项
    // 再被数据替换，是一次真实重排；booting 未声明则遮罩第二帧才出现（白闪）。
    colA: [], colB: [], aiEnabled: true,
    booting: true,
    // 菜单分类切换：categories 来自 getHomepage，menuAll 为「全部」视图的排序前 15 份底稿
    categories: [], activeCat: 'all', menuAll: []
  },

  // 就绪门只在 onLoad 建一次：tabBar 切回走 onShow 不重走 onLoad，
  // 门已 closed → 后续 onShow 的 add/hold 全部空转，遮罩不再出现。
  // onShow 里原有的「每次全量刷新」行为一行未改。
  onLoad() {
    this._boot = boot(this, { timeout: 6000 })
  },

  onShow() {
    // 显式启用右上角「转发」菜单（不调用则菜单置灰不可用）
    // ⚠️ 这里**只开启 shareAppMessage（转发给好友）**，**不开启 shareTimeline（朋友圈）**。
    //   之前虽未在 menus 里启用 shareTimeline，但页面仍定义了 onShareTimeline，
    //   部分基础库版本会在「···」菜单里照常显示「分享到朋友圈」入口；点开进入单页模式
    //   （scene 1154）无登录态、云函数需开「允许未登录访问」、路由 API 全禁用、tabBar 不渲染，
    //   首页数据又全来自 getHomepage → 用户看到「加载失败」。现直接删除 onShareTimeline，
    //   从根上移除该入口，零风险规避单页模式。
    wx.showShareMenu({ menus: ['shareAppMessage'] })

    const cached = this.readCache()
    if (cached) {
      // ⚠️ 必须先 hold 一位：缓存路径没有网络请求可占位，若首屏恰好 0 张图
      // （images(0) 不计数），settle 的那次 release 会被「防负数」规则忽略，
      // 遮罩将一直等到 6s 硬超时才关。这个坑在 booking/product 页也踩过。
      this._boot.hold()
      // 缓存命中：立刻渲染缓存数据，遮罩只等图片门。
      // 图片 URL 与上次相同 → 微信 image 组件有本地缓存，二次加载几乎瞬时。
      this.renderHomepage(cached)
      // 角色同样先用 globalData 的现值，不阻塞遮罩
      this.setData({ role: app.globalData.role || 'none' })
      // 后台静默更新：不挂就绪门。此时若遮罩已关，boot 的所有方法都空转，不会二次弹出。
      this.refreshSilently()
      app.refreshRole().then(r => {
        this.setData({ role: (r && r.role) || 'none' })
      }).catch(() => {})
    } else {
      this._boot.add(this.load())
      // 重新拉取角色，避免 onLaunch 异步未返回时拿到过期的 'none' 导致按钮不显示
      this._boot.add(app.refreshRole().then(r => {
        this.setData({ role: (r && r.role) || 'none' })
      }))
    }
  },

  // ── 缓存读写 ──
  readCache() {
    try {
      const c = wx.getStorageSync(CACHE_KEY)
      if (!c || !c.data || c.ver !== CACHE_VER) return null
      if (Date.now() - (c.ts || 0) > CACHE_TTL) {
        wx.removeStorageSync(CACHE_KEY)
        return null
      }
      return c.data
    } catch (e) { return null }
  },

  writeCache(d) {
    try { wx.setStorageSync(CACHE_KEY, { ver: CACHE_VER, ts: Date.now(), data: d }) } catch (e) { /* 配额满则忽略 */ }
  },

  // 后台静默刷新：成功则静默覆盖，失败不打扰（缓存已经把内容显示出来了）
  refreshSilently() {
    return call('getHomepage')
      .then(d => { this.writeCache(d); this.renderHomepage(d) })
      .catch(() => {})
  },

  load() {
    return call('getHomepage')
      .then(d => {
        this.writeCache(d)
        this.renderHomepage(d)
      })
      .catch(e => {
        wx.showToast({ title: e.message || '加载失败', icon: 'none' })
        this._boot.close('loadFail')
      })
  },

  // 渲染首页数据 + 声明图片门（缓存渲染与网络渲染共用同一条路径）
  renderHomepage(d) {
    // 只有首屏这一次渲染才声明图片门。静默刷新回来时遮罩通常已关（boot.closed 后
    // 所有方法空转），但若刷新比图片还快，重复声明会让计数虚高、遮罩迟迟不关。
    const first = !this._boot.closed
    const top = d.products || []
    const categories = d.categories || []
    // 关键：先用真实宽高比分列，避免「等高估算→奇偶交错→末尾堆左」的错位。
    // resolveRatios 内部走 wx.getImageInfo，单张图最多 3s 兜底，不会卡死整页。
    resolveRatios(top).then(items => {
      const cols = splitMasonry(items)
      // menuAll 始终保存「全部」视图的排序前 15 底稿；categories 同步缓存。
      // 仅当当前在「全部」视图时才同步展示（否则保留用户已选分类的列表，避免后台刷新被覆盖）。
      const patch = {
        homepage: d.homepage || {},
        projects: d.projects || [],
        featured: (d.projects && d.projects[0]) || null,
        aiEnabled: d.aiEnabled !== false,
        categories,
        menuAll: top
      }
      if (this.data.activeCat === 'all') {
        patch.products = items
        patch.colA = cols.colA
        patch.colB = cols.colB
      }
      this.setData(patch, () => {
        if (!first) return
        // 图片门：在渲染回调里统计首屏真实图片张数（此时图片尚未开始加载，
        // bindload 必然晚于声明，不会漏计）。与数据门共用同一个硬超时。
        const heroN = this.data.homepage.heroImageUrl ? 1 : 0
        // ⚠️ 按 top 统计而非 colA/colB：
        //   1) top 是本次真正渲染的数据源，分类视图（activeCat!=='all'）下 colA/colB 还是上一次的残留；
        //   2) 语义更直白——「本屏要显示几张图」而不是「两列各几张」。
        const menuN = (top || []).filter(x => x.imageUrl).length
        this._boot.images(heroN + menuN).settle(1)
      })
    })
  },

  // 分类切换：'all' 直接回到底稿（零网络）；某分类走 listProducts 取该类目全量（跨项目）
  onCatChange(e) {
    const id = e.detail.id
    if (id === this.data.activeCat) return
    if (id === 'all') {
      const top = this.data.menuAll || []
      // 真实宽高比先解析（menuAll 存的是原始底稿，无 _ratio），再分列
      resolveRatios(top).then(items => {
        const cols = splitMasonry(items)
        this.setData({ activeCat: 'all', products: items, colA: cols.colA, colB: cols.colB })
      })
      return
    }
    // 先清空再拉取，避免旧列表残留
    this.setData({ activeCat: id, products: [], colA: [], colB: [] })
    call('listProducts', { categoryId: id })
      .then(d => {
        const list = d.products || []
        resolveRatios(list).then(items => {
          const cols = splitMasonry(items)
          this.setData({ products: items, colA: cols.colA, colB: cols.colB })
        })
      })
      .catch(err => wx.showToast({ title: err.message || '加载失败', icon: 'none' }))
  },

  // bindload / binderror 共用：单张图失败也算完成，不阻塞整页
  onBootImg() {
    this._boot.image()
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

  // 转发给好友：分享店铺首页（朋友圈分享已整体移除，规避单页模式取数失败）
  onShareAppMessage() {
    const hp = this.data.homepage || {}
    return {
      title: hp.logo || '二曜路8号咖啡和清酒',
      path: '/pages/index/index'
    }
  }
})
