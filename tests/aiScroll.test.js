// tests/aiScroll.test.js — AI 预约聊天页「自动滚屏」回归测试
//
// 背景（修的 bug）：聊天记录超出容器高度后，新消息不再自动滚到底。
//   根因有两条 ——
//   ① 旧实现用 scroll-into-view 指向「刚 setData 进去、这一帧还没渲染」的新气泡节点，
//      目标不存在 ⇒ 滚动必然失效；
//   ② .msgs 只写了 flex:1，flex 子项 min-height:auto 会把容器按内容撑开，滚动条根本不生效。
//
// 本测试用桩环境加载真实的 miniprogram/pages/ai/ai.js，只验证**滚动决策逻辑**：
//   贴底时新消息要自动滚 / 用户在看历史时不得打断 / 自己发消息必须回到底 / 补滚可被用户抢断。
// 真实滚动位置由微信渲染层决定，这里断言的是 scrollTop 是否「被更新成一个更大的值」。
//
// 运行：node tests/aiScroll.test.js

const path = require('path')

const VIEW_H = 600 // 模拟可视高度（px）
const BIG = 2000   // 模拟内容高度（px）

function mkWx() {
  const q = {
    in() { return q },
    select() { return q },
    boundingClientRect(cb) { if (cb) cb({ height: VIEW_H }); return q },
    scrollOffset(cb) { if (cb) cb({ scrollTop: 0 }); return q },
    exec() {}
  }
  return {
    onWindowResize() {}, offWindowResize() {},
    createSelectorQuery() { return q },
    getPrivacySetting(o) { o && o.fail && o.fail() },
    showToast() {}, showModal() {}, showLoading() {}, hideLoading() {},
    getSetting(o) { o && o.success && o.success({ authSetting: {} }) },
    authorize() {}, openSetting() {},
    cloud: { callFunction() {} }
  }
}
global.wx = mkWx()
global.requirePlugin = () => { throw new Error('WechatSI 未启用（测试环境）') }

let CFG = null
global.Page = c => { CFG = c }
require(path.join(__dirname, '..', 'miniprogram', 'pages', 'ai', 'ai.js'))

// 把 Page 配置变成可执行实例：setData 同步合并进 data，回调走微任务
function mkPage() {
  const p = Object.assign({}, CFG)
  p.data = JSON.parse(JSON.stringify(CFG.data))
  p.setData = function (patch, cb) {
    Object.keys(patch).forEach(k => { p.data[k] = patch[k] })
    if (cb) setTimeout(cb, 0)
  }
  return p
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)) }

;(async () => {
  const p = mkPage()
  p.onLoad({})
  await sleep(20)
  ok(p.data.scrollTop > 0, '进入页面即定位到底部（scrollTop=' + p.data.scrollTop + '）')
  ok(p.data.showJump === false, '贴底时不显示「回到最新」圆钮')

  const t0 = p.data.scrollTop

  // ── 用户向上翻历史 ──
  p._viewH = VIEW_H
  p._ignoreScrollUntil = 0
  p.onScroll({ detail: { scrollTop: 0, scrollHeight: BIG } })
  ok(p._isAtBottom() === false, '翻到顶部时判定为「在看历史」')
  ok(p.data.showJump === true, '在看历史时显示「回到最新」圆钮')

  // ── AI 回话：不得打断 ──
  p.scrollBottom()
  await sleep(20)
  ok(p.data.scrollTop === t0, '在看历史时 AI 回话不强制滚动')
  ok(p.data.hasNew === true && p.data.showJump === true, '在看历史时新消息被标为「新消息」')

  // ── 一键回到底部 ──
  p.jumpBottom()
  await sleep(20)
  ok(p.data.scrollTop > t0, '点「回到最新」后滚到底部')
  ok(p.data.hasNew === false && p.data.showJump === false, '回到底部后清掉新消息标记')

  // ── 自己发消息：即使正在看历史也要回到底部 ──
  p._ignoreScrollUntil = 0
  p._scrollTop = 0; p._scrollH = BIG
  const t1 = p.data.scrollTop
  p.scrollBottom(true)
  await sleep(20)
  ok(p.data.scrollTop > t1, '自己发消息强制滚到底部')

  // ── 贴底时 AI 回话：必须自动滚 ──
  p._ignoreScrollUntil = 0
  p._scrollTop = BIG - VIEW_H; p._scrollH = BIG
  ok(p._isAtBottom() === true, '贴底判定正确（scrollHeight-scrollTop-视口≈0）')
  const t2 = p.data.scrollTop
  p.scrollBottom()
  await sleep(20)
  ok(p.data.scrollTop > t2, '贴底时 AI 回话自动滚到底部')

  // ── 补滚兜底可被用户抢断 ──
  p._ignoreScrollUntil = 0
  p.scrollBottom(true)
  await sleep(60)
  p._ignoreScrollUntil = 0
  p.onScroll({ detail: { scrollTop: 10, scrollHeight: BIG } }) // 用户抢过滚动条
  const t3 = p.data.scrollTop
  await sleep(400) // 越过补滚延迟 320ms
  ok(p.data.scrollTop === t3, '补滚前用户手动滑动则放弃补滚，不跟他抢滚动条')

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})()
