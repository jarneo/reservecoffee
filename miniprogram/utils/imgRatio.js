// miniprogram/utils/imgRatio.js
// 运行时解析菜品图真实宽高比（h/w）——**仅作兜底**。
//
// 首选来源是库里的 products.ratio（menuAdmin 上传时写入 + 存量已一次性回填），
// 因此正常情况下本模块直接跳过（见 hasStoredRatio），不发起任何网络请求、也不依赖
// downloadFile 合法域名。只有当某条菜品**缺 ratio** 时才退回 wx.getImageInfo 探测：
//   ⚠️ 官方文档：wx.getImageInfo「网络图片需先配置 download 域名才能生效」。
//      CloudBase 存储域名（xxx.tcb.qcloud.la）若未加入 downloadFile 合法域名，
//      这里必然 fail → 返回 -1 → 由 masonry.cardHeightRpx 落到 DEFAULT_RATIO。
//      正因如此，正确做法是「库里存 ratio」，而不是依赖本模块。
//
// 返回值约定：ratio = height / width（h/w），与 masonry.cardHeightRpx 一致。
// <image mode="widthFix"> 保持原比例，卡片图高 = 列宽 × ratio。
//
// ⚠️ 单张图最多等 3s（setTimeout 兜底），绝不让整页卡死在 getImageInfo 上。

// 与 masonry.js 保持一致：合法 ratio 区间 (h/w)
const RATIO_MIN = 0.2
const RATIO_MAX = 5

// 库里是否已有有效 ratio（首选来源）
function hasStoredRatio(p) {
  const r = Number(p && p.ratio)
  return isFinite(r) && r >= RATIO_MIN && r <= RATIO_MAX
}

function resolveRatios(list) {
  const items = (list || []).map(p => Object.assign({}, p))
  if (!items.length) return Promise.resolve(items)
  // ⚠️ 关键：Promise.all 解析的是「每个内部 Promise 的 resolve 值」（这里都是 undefined），
  //    必须再 .then(() => items) 把**原数组（已写入 _ratio）**交出去，
  //    否则调用方拿到 [undefined,...] → splitMasonry 把 undefined 塞进列、products 变 [undefined,...]
  //    → WXML 里 item.imageUrl 全 undefined → 全部走「暂无图」占位（即「首页图片全丢」的回归）。
  return Promise.all(items.map(p => new Promise(resolve => {
    // 库里已有有效 ratio（首选来源）→ 无需联网，直接用（本模块退化为零开销）
    if (hasStoredRatio(p)) { p._ratio = Number(p.ratio); return resolve() }
    if (!p.imageUrl) { p._ratio = -1; return resolve() }
    let done = false
    const finish = v => {
      if (done) return
      done = true
      p._ratio = v
      resolve()
    }
    wx.getImageInfo({
      src: p.imageUrl,
      success: r => finish((r && r.height && r.width) ? (r.height / r.width) : -1),
      fail: () => finish(-1)
    })
    // 兜底超时：单个图最多等 3s，避免整体卡死在 getImageInfo
    setTimeout(() => finish(-1), 3000)
  }))).then(() => items)
}

module.exports = { resolveRatios, hasStoredRatio }
