// 瀑布流分列算法单测：验证「按预估高度贪心分列」的两列高度差 ≤ 一张卡
// 用相对路径（__dirname 上溯）定位模块，保证 mac / windows 都能跑
//
// ⚠️ ratio 语义 = 图片高/宽（h/w）。卡片图高 = 列宽 × ratio（与 <image mode="widthFix"> 一致）。
//    历史上曾误用「列宽 / ratio」，本测试专门锁死「乘法」这一正确形态（见 [6]）。
const path = require('path')
const M = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'masonry.js'))

let pass = 0, fail = 0
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS ' + msg) } else { fail++; console.log('  FAIL ' + msg) } }

// 造 n 张卡：ratio 可指定，缺省留空（模拟存量未重传图）
function mkCards(n, ratio) {
  const out = []
  for (let i = 0; i < n; i++) {
    const c = { _id: 'p' + i, name: '菜' + i }
    if (ratio !== undefined) c.ratio = ratio
    out.push(c)
  }
  return out
}

;(async () => {
  console.log('\n[1] 基本：空数组 / 单项')
  {
    const e = M.splitMasonry([])
    ok(e.colA.length === 0 && e.colB.length === 0, '空数组 → 两列都空')
    ok(e.heightA === 0 && e.heightB === 0, '空数组 → 两列高都为 0')

    const one = M.splitMasonry(mkCards(1))
    ok(one.colA.length + one.colB.length === 1, '单项 → 不丢卡')
    ok(one.colA.length === 1 && one.colB.length === 0, '单项 → 进第一列（hA=0 <= hB=0 走 A）')
  }

  console.log('\n[2] 不丢卡：所有项都出现在某一列，且不重复')
  {
    const src = mkCards(15)
    const r = M.splitMasonry(src)
    ok(r.colA.length + r.colB.length === 15, '15 项 → 两列合计 15（无丢失）')
    const ids = r.colA.concat(r.colB).map(x => x._id)
    ok(new Set(ids).size === 15, '15 项 → 无重复')
    const order = ids.slice().sort()
    ok(order.join(',') === src.map(x => x._id).sort().join(','), '15 项 → 卡片集合与输入一致')
  }

  console.log('\n[3] 核心指标：两列高度差 ≤ 一张卡高度')
  {
    // ratio 混用的刁钻场景：竖图/横图/缺省交错，最容易失衡
    const tricky = [
      { _id: 'a', ratio: 0.5 }, { _id: 'b', ratio: 3.0 }, { _id: 'c' },
      { _id: 'd', ratio: 0.7 }, { _id: 'e', ratio: 2.0 }, { _id: 'f', ratio: 1.0 },
      { _id: 'g', ratio: 0.6 }, { _id: 'h', ratio: 2.5 }, { _id: 'i' },
      { _id: 'j', ratio: 0.9 }, { _id: 'k', ratio: 1.8 }, { _id: 'l', ratio: 0.4 },
      { _id: 'm', ratio: 2.2 }, { _id: 'n' }, { _id: 'o', ratio: 1.1 }
    ]
    const r = M.splitMasonry(tricky)
    const maxCard = Math.max.apply(null, tricky.map(M.cardHeightRpx))
    const diff = Math.abs(r.heightA - r.heightB)
    ok(diff <= maxCard, '15 项混合比例 → 高度差 ' + diff + ' ≤ 单卡最大高 ' + maxCard)
  }

  console.log('\n[4] 等高卡：贪心退化为 8/7 交替（这是奇偶数量的固有下界，不是缺陷）')
  {
    // 15 张等高卡无法均分（不能 7.5/7.5），最优解必然是 8/7 → 差 1 张卡。
    const same = mkCards(15, 1.3)
    const r = M.splitMasonry(same)
    const oneCard = M.cardHeightRpx(same[0])
    ok(r.colA.length === 8 && r.colB.length === 7, '等高 15 项 → 8/7 交替分配')
    ok(Math.abs(r.heightA - r.heightB) === oneCard,
      '等高 15 项 → 差值恰为 1 张卡(' + oneCard + 'rpx)，即理论最优')
    ok(r.heightA > r.heightB, '等高 15 项 → 末项进 A 列，故 A 略高（与实际一致）')
  }

  console.log('\n[4b] 关键区分：比例有差异时，贪心显著优于奇偶分列')
  {
    const mixed = [
      { _id: 'a', ratio: 0.75 }, { _id: 'b', ratio: 1.60 }, { _id: 'c', ratio: 0.90 },
      { _id: 'd', ratio: 1.30 }, { _id: 'e', ratio: 0.65 }, { _id: 'f', ratio: 1.85 },
      { _id: 'g', ratio: 1.10 }, { _id: 'h', ratio: 0.80 }, { _id: 'i', ratio: 1.45 },
      { _id: 'j', ratio: 0.70 }, { _id: 'k', ratio: 1.20 }, { _id: 'l', ratio: 0.95 },
      { _id: 'm', ratio: 1.55 }, { _id: 'n', ratio: 0.85 }, { _id: 'o', ratio: 1.35 }
    ]
    const r = M.splitMasonry(mixed)
    const mineDiff = Math.abs(r.heightA - r.heightB)
    const maxCard = Math.max.apply(null, mixed.map(M.cardHeightRpx))

    const even = mixed.filter((_, i) => i % 2 === 0)
    const odd = mixed.filter((_, i) => i % 2 === 1)
    const sum = a => a.reduce((s, x) => s + M.cardHeightRpx(x), 0)
    const oddDiff = Math.abs(sum(even) - sum(odd))

    ok(mineDiff < oddDiff, '混合比例 15 项 → 贪心偏差(' + mineDiff + ') < 奇偶偏差(' + oddDiff + ')')
    ok(mineDiff < maxCard, '混合比例 15 项 → 贪心偏差 ' + mineDiff + ' < 单卡最大高 ' + maxCard)
    const avg = Math.round(mixed.reduce((s, x) => s + M.cardHeightRpx(x), 0) / mixed.length)
    ok(mineDiff < avg, '混合比例 → 贪心偏差(' + mineDiff + ') < 平均卡高(' + avg + ')，远优于奇偶的 8-7 张量级')
  }

  console.log('\n[5] ratio 兜底：非法值走默认值')
  {
    ok(M.ratioOf({ ratio: 1.3 }) === 1.3, '正常 ratio 原样返回')
    ok(M.ratioOf({}) === M.DEFAULT_RATIO, '缺 ratio → DEFAULT_RATIO')
    ok(M.ratioOf({ ratio: null }) === M.DEFAULT_RATIO, 'null → DEFAULT_RATIO')
    ok(M.ratioOf({ ratio: 0 }) === M.DEFAULT_RATIO, '0 → DEFAULT_RATIO（防除零）')
    ok(M.ratioOf({ ratio: -1 }) === M.DEFAULT_RATIO, '负数 → DEFAULT_RATIO')
    ok(M.ratioOf({ ratio: 9 }) === M.DEFAULT_RATIO, '超上限 5 → DEFAULT_RATIO')
    ok(M.ratioOf({ ratio: 'abc' }) === M.DEFAULT_RATIO, '非数字 → DEFAULT_RATIO')
    ok(M.ratioOf(null) === M.DEFAULT_RATIO, 'item 为 null → DEFAULT_RATIO')
    ok(M.ratioOf(0.5) === M.DEFAULT_RATIO, 'item 是数字（非对象）→ DEFAULT_RATIO')
    ok(isFinite(M.cardHeightRpx({})), '缺 ratio 时高度仍是有限数')
  }

  console.log('\n[6] 高度公式：ratio(h/w) 越大卡片越高（乘法 列宽×ratio）')
  {
    // ⚠️ 回归护栏：历史 BUG 曾写成「列宽 / ratio」（把 h/w 当成 w/h 用），导致竖图估矮、横图估高。
    const wide = M.cardHeightRpx({ ratio: 0.5 })    // h/w 小 = 扁宽 → 矮
    const square = M.cardHeightRpx({ ratio: 1.0 })
    const tall = M.cardHeightRpx({ ratio: 2.0 })    // h/w 大 = 高瘦 → 高
    ok(wide < square && square < tall, 'ratio 0.5 < 1.0 < 2.0 的高度递增成立（乘法语义）')
    ok(M.cardHeightRpx({ ratio: 0.2 }) === Math.round(M.COL_W_RPX * 0.2) + M.FIXED_RPX,
      '公式 = 列宽×ratio + 固定区（不是 列宽/ratio）')
  }

  console.log('\n[7] 只读不改：不修改传入数组与元素')
  {
    const src = mkCards(5, 1.2)
    const before = JSON.stringify(src)
    M.splitMasonry(src)
    ok(JSON.stringify(src) === before, '传入数组未被修改')
  }

  console.log('\n[8] 真实数据回归：13 张菜品图（12 横 3:2 + 1 竖图）末尾不堆同一侧')
  {
    // 线上真实数据（h/w，按 getHomepage 的 sort 升序）：琥珀女王是唯一竖图(h/w≈1.577)，
    // 其余基本是 1920x1280 的 3:2 横图(h/w≈0.667)，生巧慕斯 400x289(h/w≈0.7225)。
    // 这就是用户反馈「末尾堆在同一侧」的真实场景：
    //   旧公式(÷)下真实底边差 ≈ 632rpx（≈2 张卡）；修正为(×)后 ≈ 30rpx，近乎齐平。
    const real = [
      { _id: 'a', name: '琥珀女王', ratio: 1.577 },
      { _id: 'b', name: '曜混合', ratio: 0.667 },
      { _id: 'c', name: '极深烘曼特宁', ratio: 0.667 },
      { _id: 'd', name: '热巧克力', ratio: 0.667 },
      { _id: 'e', name: '焦糖布丁', ratio: 0.667 },
      { _id: 'f', name: 'Hello混合', ratio: 0.667 },
      { _id: 'g', name: '肯尼亚', ratio: 0.667 },
      { _id: 'h', name: '瑰夏', ratio: 0.667 },
      { _id: 'i', name: '海南罗豆', ratio: 0.667 },
      { _id: 'j', name: '黑桶蓝山', ratio: 0.667 },
      { _id: 'k', name: '坦桑尼亚', ratio: 0.667 },
      { _id: 'l', name: '黄油混合', ratio: 0.667 },
      { _id: 'm', name: '生巧慕斯', ratio: 0.7225 }
    ]
    const r = M.splitMasonry(real)
    const diff = Math.abs(r.heightA - r.heightB)
    const oneCard = M.cardHeightRpx({ ratio: 0.667 })   // 横图卡高 ≈ 301rpx
    ok(r.colA.length + r.colB.length === 13, '13 项 → 不丢卡')
    ok(diff < oneCard, '两列真实底边差 ' + diff + ' < 一张横图卡高 ' + oneCard + '（旧公式实测达 632）')

    // 尾部不堆同一侧：最后两张（索引 11、12）必须落在不同列
    const sideOf = {}
    r.colA.forEach(x => sideOf[x._id] = 'A')
    r.colB.forEach(x => sideOf[x._id] = 'B')
    ok(sideOf['l'] !== sideOf['m'], '最后两项(黄油混合:' + sideOf['l'] + ' / 生巧慕斯:' + sideOf['m'] + ')在**不同列**，末尾未堆同一侧')
  }

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' passed, ' + fail + ' failed')
  if (fail > 0) process.exit(1)
})()
