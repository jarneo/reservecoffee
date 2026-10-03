// utils/imgRatio 单测：验证 resolveRatios 返回「带 _ratio 的原数组」而非 [undefined,...]
// （回归：曾因 Promise.all 解析为内部 resolve 的 undefined 值，导致 products 变 [undefined,...]、图片全丢）
const path = require('path')
const M = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'imgRatio.js'))

let pass = 0, fail = 0
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS ' + msg) } else { fail++; console.log('  FAIL ' + msg) } }

// 模拟微信：getImageInfo 立即成功返回 100x130（ratio=1.3）
global.wx = {
  getImageInfo({ src, success, fail }) {
    if (!src) return fail && fail(new Error('no src'))
    success({ width: 100, height: 130 })
  }
}

;(async () => {
  console.log('\n[1] 返回原数组（非 undefined 列表）')
  {
    const list = [{ _id: 'p1', name: '菜1', imageUrl: 'https://x/1.jpg' }, { _id: 'p2', name: '菜2', imageUrl: 'https://x/2.jpg' }]
    const items = await M.resolveRatios(list)
    ok(Array.isArray(items), '返回数组')
    ok(items.length === 2, '长度不变（2）')
    ok(items[0] && items[0]._id === 'p1', '第 0 项仍是原对象（带 _id）')
    ok(items[1] && items[1]._id === 'p2', '第 1 项仍是原对象（带 _id）')
    ok(items[0]._ratio > 0, '第 0 项已解析出真实 _ratio（' + items[0]._ratio + '）')
    ok(Math.abs(items[0]._ratio - 1.3) < 1e-6, '_ratio == 130/100 == 1.3')
    ok(items[0].imageUrl === 'https://x/1.jpg', 'imageUrl 原样保留（图片不丢）')
    ok(items !== list, '返回新数组（不改传入）')
  }

  console.log('\n[2] 无 imageUrl 的项 _ratio=-1，但不丢')
  {
    const list = [{ _id: 'p0', name: '无图', imageUrl: '' }, { _id: 'p1', name: '有图', imageUrl: 'https://x/1.jpg' }]
    const items = await M.resolveRatios(list)
    ok(items[0]._ratio === -1, '无图项 _ratio = -1')
    ok(items[1]._ratio > 0, '有图项正常解析')
    ok(items.length === 2, '两项的数组，未丢项')
  }

  console.log('\n[3] 空数组安全')
  {
    const items = await M.resolveRatios([])
    ok(Array.isArray(items) && items.length === 0, '空数组 → 空数组')
  }

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' passed, ' + fail + ' failed')
  if (fail > 0) process.exit(1)
})()
