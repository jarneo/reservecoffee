// miniprogram/utils/masonry.js
// 首页/菜单页双列瀑布流：按**真实图片高度贪心分列**（总是把卡片给当前较矮的一列）。
//
// ── ratio 语义（务必统一，这里踩过大坑）──────────────────────────────────────
//   ratio = 图片高 / 图片宽（height / width）。
//   - 与 imgRatio.js 的 `_ratio`（= r.height / r.width）、menuAdmin 上传时写入的
//     products.ratio（= h / w）**完全一致**。
//   - <image mode="widthFix"> 下：图片渲染高 = 列宽 × (原高/原宽) = 列宽 × ratio。
//   🔴 历史 BUG（本文件已修）：cardHeightRpx 曾写成 `列宽 / ratio`（把它当成「宽/高」），
//      分母分子颠倒 → 竖图被估矮、横图被估高，两列「平衡」是在**错误高度**上算的，
//      真实渲染出来的底边差能到 2 张卡（实测 632rpx），表现就是「末尾堆在同一侧」。
//
// 分列逻辑演进：
//   ① 按索引奇偶拆两列（已弃用）：0,2,4…进左列，完全不看卡片高度。15 项必左 8 右 7。
//   ② 按预估高度贪心（上一代）：用 ratio 估高，但公式颠倒（见上）+ 存量无 ratio 全退默认
//      → 失衡被放大。
//   ③ 本代：公式修正为 `列宽 × ratio`；ratio 优先取库里的 products.ratio（已回填 + 上传时写入），
//      运行时 getImageInfo（imgRatio.js）仅作缺 ratio 时的兜底。等高时用「少者优先」破除永远偏左，
//      尾部再微调一次，压掉「末尾连续多项堆在同一侧」的观感。
//
// 纯函数、无副作用、不依赖 wx —— 可直接在 node 里单测（wx 依赖在 imgRatio.js）。

// 缺 ratio 时的兜底比值（h/w）：取 1.0 平面中性值。
// ⚠️ 实测本店 13 张菜品图：12 张是 3:2 横构图（h/w≈0.667），1 张竖图（h/w≈1.577）。
//    旧默认 1.30 是「菜品多为竖构图」的错误假设，会让无 ratio 卡片一律估高 343×1.30+72=518rpx，
//    与实际（横图 301rpx）偏差过大，故回落中性 1.0。（正常路径下库里都有 ratio，用不到兜底。）
const DEFAULT_RATIO = 1.0
// 无图卡片的固定高度（仅文字区：边框 + .menu-info 上下 padding + 名称/价格行）
const NO_IMG_H = 96
// 文字区固定高度：边框 2rpx + .menu-info 上下 padding 16*2 + 名称/价格同行约 38
const FIXED_RPX = 72
// 列宽：(750 - 页面左右 padding 24*2 - 列间 gap 16) / 2，与 index.wxss 的 .menu-cols 对齐
const COL_W_RPX = 343
// 等高判定容差：两列高度差 ≤ 1rpx 视为「等高」，走「少者优先」的对称 tie-break
const EPS = 1

// 合法 ratio 区间（h/w）：低于 0.2（极端横图）或高于 5（极端长竖图）都视为数据异常，走兜底
const RATIO_MIN = 0.2
const RATIO_MAX = 5

// 取有效 ratio（h/w），非法/缺失返回 DEFAULT_RATIO
function ratioOf(item) {
  const r = Number(item && item.ratio)
  if (isFinite(r) && r >= RATIO_MIN && r <= RATIO_MAX) return r
  return DEFAULT_RATIO
}

// 单张卡片的预估高度（rpx），优先级：
//   _ratio>0（运行时解析成功，h/w）→ 列宽 × _ratio；
//   显式有效 ratio（库里已存/店主重传，h/w）→ 列宽 × ratio；
//   有 imageUrl 但无比值 → 列宽 × DEFAULT_RATIO；
//   真正无图（无 imageUrl 且无比值）→ 仅文字区 NO_IMG_H。
//   🔑 一律是「列宽 × ratio」（乘法）——ratio 是 h/w，与 widthFix 的渲染高一致。
function cardHeightRpx(item) {
  const dyn = Number(item && item._ratio)
  if (isFinite(dyn) && dyn > 0) return Math.round(COL_W_RPX * dyn) + FIXED_RPX
  const r = Number(item && item.ratio)
  if (isFinite(r) && r >= RATIO_MIN && r <= RATIO_MAX) return Math.round(COL_W_RPX * r) + FIXED_RPX
  if (item && item.imageUrl) return Math.round(COL_W_RPX * DEFAULT_RATIO) + FIXED_RPX
  return NO_IMG_H
}

function sumHeight(list) {
  return (list || []).reduce((s, it) => s + cardHeightRpx(it), 0)
}

// 尾部微调：把「较高列的最后一项」移到「较矮列」，若能缩小两列高度差则移动。
// 一次移动足够——它专门消除「末尾连续多项堆在同一侧、对侧空缺」的观感，
// 又不引发循环重排（仅看最后一项，移动后不再迭代）。
function rebalance(colA, colB) {
  let heightA = sumHeight(colA)
  let heightB = sumHeight(colB)
  if (colA.length === 0 || colB.length === 0) return { colA, colB, heightA, heightB }
  const taller = heightA >= heightB ? colA : colB
  const shorter = heightA >= heightB ? colB : colA
  const lastH = cardHeightRpx(taller[taller.length - 1])
  const gap = Math.abs(heightA - heightB)
  // 把较高列末项移到较矮列后的新高度差 = |gap - 2*lastH|。
  // 仅当 lastH < gap（严格）时新差更小才移动；lastH === gap 时只是把「谁更高」翻转、差距不变，
  // 反而打乱既有分配断言，故不移动。这能消除「末尾堆同一侧」而不引发无谓重排。
  if (lastH < gap) {
    shorter.push(taller.pop())
    heightA = sumHeight(colA)
    heightB = sumHeight(colB)
  }
  return { colA, colB, heightA, heightB }
}

// 贪心分列 + 尾部微调。返回 { colA, colB, heightA, heightB }
// heightA/heightB 供调用方做断言与调试（两列总高）。
function splitMasonry(list) {
  const colA = []
  const colB = []
  let heightA = 0
  let heightB = 0
  // 防御：过滤掉非对象项（如上游误传的 undefined），避免把 undefined 塞进列、
  //     导致 WXML 里 item.imageUrl 全 undefined（图片全丢）。resolveRatios 修好后正常不会触发。
  ;((list || []).filter(it => it && typeof it === 'object')).forEach(it => {
    const h = cardHeightRpx(it)
    // 矮者先得；等高时优先放进「项数更少」的列，破除「永远偏左」的系统性偏置
    const aShorter = heightA < heightB - EPS
    const bShorter = heightB < heightA - EPS
    let toA
    if (aShorter) toA = true
    else if (bShorter) toA = false
    else toA = colA.length <= colB.length
    if (toA) { colA.push(it); heightA += h } else { colB.push(it); heightB += h }
  })
  return rebalance(colA, colB)
}

module.exports = { splitMasonry, cardHeightRpx, ratioOf, sumHeight, COL_W_RPX, FIXED_RPX, NO_IMG_H, DEFAULT_RATIO, RATIO_MIN, RATIO_MAX, EPS }
