// tests/index-cache.test.js — 首页 SWR 缓存 + 就绪门计数的行为仿真
//
// 重点验证三个容易出错的点：
//   1) 缓存路径没有网络请求占位，首屏 0 张图时（images(0) 不计数）
//      遮罩必须能正常关闭，不能干等 6s 硬超时（这个坑在 booking/product 页踩过）
//   2) 有 N 张图时必须等 N 张全部 bindload 才关
//   3) 静默刷新回来时若遮罩已关，重复声明图片门不得让计数虚高
//   4) 缓存的 TTL / 版本隔离 / 写入失败降级
//
// 运行：node tests/index-cache.test.js

const path = require('path')
let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)) }

// ── 模拟 wx / Page 环境 ──
const storage = {}
global.wx = {
  setStorageSync: (k, v) => { storage[k] = v },
  getStorageSync: k => (k in storage ? storage[k] : ''),
  removeStorageSync: k => { delete storage[k] },
  showToast: () => {},
  showShareMenu: () => {}
}
global.getApp = () => ({ globalData: { role: 'owner' }, refreshRole: () => Promise.resolve({ role: 'owner' }) })

const boot = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'boot.js'))

// 复刻 index.js 的相关逻辑（保持与源码同步）
const CACHE_KEY = 'homepageCacheV1'
const CACHE_VER = 1
const CACHE_TTL = 10 * 60 * 1000

function mkPage(homepageData) {
  const ctx = {
    data: { homepage: {}, projects: [], products: [], colA: [], colB: [], booting: true, heroImageUrl: '' },
    setData(obj, cb) {
      Object.assign(this.data, obj)
      if (typeof cb === 'function') setTimeout(cb, 0)
    }
  }
  ctx._boot = boot(ctx, { timeout: 6000 })
  ctx.readCache = function () {
    try {
      const c = global.wx.getStorageSync(CACHE_KEY)
      if (!c || !c.data || c.ver !== CACHE_VER) return null
      if (Date.now() - (c.ts || 0) > CACHE_TTL) { global.wx.removeStorageSync(CACHE_KEY); return null }
      return c.data
    } catch (e) { return null }
  }
  ctx.writeCache = function (d) {
    try { global.wx.setStorageSync(CACHE_KEY, { ver: CACHE_VER, ts: Date.now(), data: d }) } catch (e) {}
  }
  ctx.renderHomepage = function (d) {
    const first = !this._boot.closed
    const products = d.products || []
    const colA = products.filter((_, i) => i % 2 === 0)
    const colB = products.filter((_, i) => i % 2 === 1)
    this.setData({ homepage: d.homepage || {}, projects: d.projects || [], products, colA, colB }, () => {
      if (!first) return
      const heroN = this.data.homepage.heroImageUrl ? 1 : 0
      const menuN = colA.filter(x => x.imageUrl).length + colB.filter(x => x.imageUrl).length
      this._boot.images(heroN + menuN).settle(1)
    })
  }
  ctx.onShowWithCache = function () {
    const cached = this.readCache()
    if (cached) {
      this._boot.hold()            // ← 关键：缓存路径手动占一位
      this.renderHomepage(cached)
    }
    return !!cached
  }
  return ctx
}

const tick = (n = 6) => new Promise(r => setTimeout(r, n))

async function run() {
  console.log('\n[1] 缓存命中 + 首屏 0 张图 → 遮罩必须正常关闭（不能等 6s 超时）')
  {
    storage[CACHE_KEY] = { ver: CACHE_VER, ts: Date.now(), data: { homepage: {}, projects: [], products: [] } }
    const p = mkPage()
    const hit = p.onShowWithCache()
    ok(hit === true, '缓存命中')
    await tick(80)
    ok(p.data.booting === false, `遮罩已关闭（booting=${p.data.booting}）`)
    ok(p._boot.closed === true, '就绪门已 closed')
  }

  console.log('\n[2] 缓存命中 + 3 张图 → 必须等 3 张全部加载完')
  {
    storage[CACHE_KEY] = { ver: CACHE_VER, ts: Date.now(), data: {
      homepage: { heroImageUrl: 'x.jpg' },
      projects: [],
      products: [{ _id: 'a', imageUrl: 'a.jpg' }, { _id: 'b', imageUrl: 'b.jpg' }]
    } }
    const p = mkPage()
    p.onShowWithCache()
    await tick(80)
    ok(p.data.booting === true, '图片未加载完 → 遮罩仍显示')
    p._boot.image(); await tick(4)
    ok(p.data.booting === true, '第 1 张加载完 → 仍未关（还有 2 张）')
    p._boot.image(); await tick(4)
    ok(p.data.booting === true, '第 2 张加载完 → 仍未关（还有 1 张）')
    p._boot.image(); await tick(80)
    ok(p.data.booting === false, '第 3 张加载完 → 关闭')
  }

  console.log('\n[3] 遮罩关闭后静默刷新 → 不得重复声明图片门（计数不能虚高）')
  {
    storage[CACHE_KEY] = { ver: CACHE_VER, ts: Date.now(), data: { homepage: {}, projects: [], products: [] } }
    const p = mkPage()
    p.onShowWithCache()
    await tick(80)
    ok(p.data.booting === false, '首屏已关闭')
    // 模拟 refreshSilently 回来后再次渲染
    p.renderHomepage({ homepage: {}, projects: [], products: [{ _id: 'x', imageUrl: 'x.jpg' }] })
    await tick(80)
    ok(p._boot.closed === true && p.data.booting === false, '静默刷新后遮罩没有复活')
    ok(p._boot.pending === 0, `计数未被污染（pending=${p._boot.pending}）`)
  }

  console.log('\n[4] 缓存版本隔离：ver 不匹配 → 视为无缓存')
  {
    storage[CACHE_KEY] = { ver: 99, ts: Date.now(), data: { homepage: {}, products: [] } }
    const p = mkPage()
    ok(p.readCache() === null, '旧版本缓存被忽略')
  }

  console.log('\n[5] 缓存过期：超过 TTL → 清除并视为无缓存')
  {
    storage[CACHE_KEY] = { ver: CACHE_VER, ts: Date.now() - 11 * 60 * 1000, data: { homepage: {} } }
    const p = mkPage()
    ok(p.readCache() === null, '超过 10 分钟 → 缓存失效')
    ok(!(CACHE_KEY in storage), '过期缓存已被清除，不占空间')
  }

  console.log('\n[6] 无缓存 → 走正常「等网络」路径')
  {
    delete storage[CACHE_KEY]
    const p = mkPage()
    ok(p.readCache() === null, '无缓存')
    ok(p.onShowWithCache() === false, '不进缓存分支')
    await tick(80)
    ok(p.data.booting === true, '遮罩保持显示，等待网络数据（符合预期）')
  }

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`)
  process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('测试崩溃:', e); process.exit(1) })
