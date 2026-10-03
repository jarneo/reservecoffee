// pages/result/result — 预约成功结果页
//
// 由 pages/confirm 在 createReservation 成功后 redirectTo 而来（替代原弹层）：
//   上方 = 与原弹层视觉一致的留座信息（文档流内块，非 fixed 遮罩）
//   下方 = 完整店铺菜单（分类 tabs + 真·瀑布流双列），与首页共用 masonry 实现
//
// ⚠️ 关键设计点：
//   ① 参数逐字段 encodeURIComponent，**绝不塞 JSON**；
//   ② 默认分类用**实例变量** this._wantCat 暂存，等 categories 返回后再校验 ——
//      若在 data.activeCat 上直接设具体 id，首页那份 `if (activeCat==='all')` 的
//      守卫分支就不会执行，菜单会永久空白且 boot 图片门不结算（用户看到「空菜单 + 无遮罩」）；
//   ③ 分类失效（项目配置的分类被删）→ 回退「全部」。
const { call } = require('../../utils/cloud')
const boot = require('../../utils/boot')
const { splitMasonry } = require('../../utils/masonry')

Page({
  data: {
    // 上方留座信息
    projectName: '', date: '', start: '', end: '',
    partySize: 1, needReview: false, phone: '',
    // 下方菜单
    categories: [], activeCat: 'all', products: [],
    colA: [], colB: [],
    menuLoading: true, menuFailed: false,
    catHint: '',
    booting: true
  },

  onLoad(q) {
    this._boot = boot(this, { timeout: 6000 })
    const o = q || {}
    this.projectId = o.pid || ''
    this.setData({
      projectName: decodeURIComponent(o.pn || ''),
      date: decodeURIComponent(o.d || ''),
      start: decodeURIComponent(o.ss || ''),
      end: decodeURIComponent(o.se || ''),
      partySize: Number(o.ps) || 1,
      needReview: o.nr === '1',
      phone: decodeURIComponent(o.ph || '')
    })
    // ⚠️ 默认分类只存实例变量 this._wantCat，**不进 data** ——
    //    见文件头 ②：若在 data.activeCat 上直接设具体 id，首页那份
    //    `if (activeCat==='all')` 守卫分支就不执行，菜单会永久空白且 boot 门不结算。
    // 初始为 'all'，随后按项目配置 resultCategoryId 覆盖（并做有效性校验）。
    this._wantCat = 'all'
    this.loadMenu()
  },

  // 取项目的「结果页默认分类」配置。失败静默降级为「全部」，不阻断页面。
  loadWantCat() {
    if (!this.projectId) return Promise.resolve('all')
    return call('getProject', { projectId: this.projectId })
      .then(d => {
        const id = (d && d.project && d.project.resultCategoryId) || ''
        return id || 'all'
      })
      .catch(() => 'all')
  },

  loadMenu() {
    // 三跳并行。不调 getHomepage：它连带返回 projects + 全量 schedules（8+ 次 DB 往返），
    // 其中大部分对结果页无用。
    // ⚠️ 用 this._boot.add(...) 包住整条链路：add 会在 resolve/reject 时自动释放就绪门。
    //   （之前误写成 add(Promise.resolve()).settle(1) —— add 返回的是 promise 而非门对象，
    //    .settle 不存在会抛 TypeError，被外层 catch 捕获 → menuFailed，表现为「菜单加载报错」。）
    this._boot.add(
      Promise.all([
        this.loadWantCat(),
        call('listCategories').catch(() => ({ categories: [] })),
        call('listProducts').catch(() => ({ products: [] }))
      ])
        .then(([wantRaw, catRes, prodRes]) => {
          const categories = (catRes && catRes.categories) || []
          const products = (prodRes && prodRes.products) || []
          // 分类失效兜底：项目配置的分类被 deleteCategory 删掉后，
          // wantRaw 会变成悬空引用（存的是 _id 字符串）→ 此时回退「全部」
          let want = wantRaw
          if (want && want !== 'all' && !categories.some(c => c._id === want)) want = 'all'

          // 命中非「全部」的默认分类时，本次只展示该分类（listProducts 不带参拿的是全部）
          if (want !== 'all') {
            // 二次拉取也用 add 包住，让就绪门等它完成（返回该 promise，外层链路会等它 settle）
            return this._boot.add(
              call('listProducts', { categoryId: want })
                .then(d => {
                  const list = (d && d.products) || []
                  this.setData({ categories, products: list, activeCat: want, catHint: this._catHint(want, categories), menuLoading: false })
                  this.applyCols(list)
                })
                .catch(() => {
                  // 该分类拉取失败 → 退回展示全部，不要让用户看到空菜单
                  this.setData({ categories, products, activeCat: 'all', catHint: '全部', menuLoading: false })
                  this.applyCols(products)
                })
            )
          }

          this.setData({
            categories,
            products,
            activeCat: want || 'all',
            catHint: this._catHint(want || 'all', categories),
            menuLoading: false
          })
          this.applyCols(products)
        })
        .catch(() => {
          this.setData({ menuLoading: false, menuFailed: true })
        })
    )
  },

  _catHint(want, categories) {
    if (!want || want === 'all') return '全部'
    const hit = categories.find(c => c._id === want)
    return hit ? hit.name : '全部'
  },

  // 瀑布流分列（与首页共用 utils/masonry）
  applyCols(list) {
    const cols = splitMasonry(list || [])
    this.setData({ colA: cols.colA, colB: cols.colB })
  },

  onCatChange(e) {
    const id = (e && e.detail && e.detail.id) || 'all'
    if (id === this.data.activeCat) return
    if (id === 'all') {
      // 回到「全部」：已在本页拿到过全量，直接重排，无需请求
      this.setData({ activeCat: 'all', catHint: this._catHint('all', this.data.categories) })
      this.applyCols(this.data.products)
      return
    }
    // 选具体分类 → 拉该类目全量（categories 是全局的，跨项目）
    this.setData({ activeCat: id, catHint: this._catHint(id, this.data.categories) })
    call('listProducts', { categoryId: id })
      .then(d => {
        const list = (d && d.products) || []
        this.setData({ products: list })
        this.applyCols(list)
      })
      .catch(() => this.setData({ menuFailed: true }))
  },

  retryMenu() {
    this.setData({ menuLoading: true, menuFailed: false })
    this.loadMenu()
  },

  goMine() { wx.switchTab({ url: '/pages/mine/mine' }) },
  goProduct(e) {
    const id = (e && e.currentTarget && e.currentTarget.dataset.id) || ''
    if (id) wx.navigateTo({ url: '/pages/product/product?productId=' + id })
  },
  // 返回首页：不带 cat —— 首页没有「?cat=」入参解析（本期未做），传了也无效。
  // 若将来要让首页直接落到某个分类，需给 index.js 加 onLoad(options) + renderHomepage 校验逻辑。
  goHome() { wx.reLaunch({ url: '/pages/index/index' }) }
})
