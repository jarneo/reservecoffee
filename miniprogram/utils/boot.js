// utils/boot.js — 首屏「资源就绪门」（hold / release 计数池）
//
// 用途：页面上报「我在等 N 件事」，全部完成（计数归零）后关闭全屏 loading 遮罩。
//
// 为什么用计数池而不是命名门：
//   命名门（按名字开/关）在「后声明的门先完成」时会提前关闭。典型如 index 页——
//   图片门是在数据 setData 的渲染回调里才声明张数的，若按名字判定就会先关掉遮罩。
//   计数池只关心「还有几件没完成」，串行链无论多深，只要每一跳成对插入就自动收敛，
//   **不需要精确知道末端在哪**（booking / confirm / mine 的串行链就是靠这一点收敛的）。
//
// 用法（页面）：
//   onLoad() { this._boot = boot(this, { timeout: 6000 }) }
//   data:    { booting: true }              // ⚠️ 必须显式声明，否则首帧遮罩不显示（白闪）
//   模板:    <page-loading show="{{booting}}" />
//   load() { this._boot.add(call('xxx')).then(...) }   // add 对 then/catch 都自动 release
//   .catch(e => { wx.showToast(...); this._boot.close() })   // 失败必须显式关
//
// 用法（在线调试）：
//   SLOW = 2500        本地模拟慢加载，观察遮罩效果（严禁改 utils/cloud.js）
//   ENABLED = false    应急：全站立即关闭遮罩，不用删任何接入代码

// ===== 当前接入范围（2026-09-27 收敛）=====
// 只在顾客侧主链路 5 页：index / booking / confirm / mine / menu。
// 管理端 20 页、ai、product、shareMenu、notifyPref 均已回退，不做遮罩。
// 新增页面接入时照下面「用法（页面）」三步即可，组件已在 app.json 全局注册。

// ===== 应急开关 =====
// ENABLED = false → 全站立即关闭遮罩（不删任何接入代码即可回退）
const ENABLED = true

// ===== 本地调试：模拟慢加载（毫秒）=====
// 本地验证遮罩效果时改成 2500；**验证完毕必须改回 0**。
// ⚠️ 严禁改 utils/cloud.js 来模拟慢网，那会污染真实请求链路。
const SLOW = 0

// 默认硬超时。云函数冷启动常见 1.5~3s，弱网叠加可到 5s，6s 是「还不觉得卡死」的上限。
const DEFAULT_TIMEOUT = 6000

// 无操作实例（ENABLED=false 时返回），避免页面里到处判空
const NOOP = {
  hold() { return NOOP }, release() { return NOOP }, settle() { return NOOP },
  add() { return NOOP }, images() { return NOOP }, image() { return NOOP },
  close() { return NOOP }, closed: true
}

/**
 * 创建（或复用）页面的就绪门。
 * @param {object} ctx  页面/组件实例（Page 或 Component 的 this）
 * @param {object} opts { timeout?: number, field?: string, warn?: boolean }
 * @returns 门控制对象
 *
 * ⚠️ 单例语义：同一 ctx 重复调用只建一个实例、一个 timer，并把计数 +1。
 *   这样「页面自己建一次 + adminGuard 又建一次」不会产生两个 timer 互相打架。
 */
function createBoot(ctx, opts) {
  opts = opts || {}

  if (!ENABLED) {
    ctx.setData({ [opts.field || 'booting']: false })
    return NOOP
  }

  if (ctx._boot) { ctx._boot.hold(); return ctx._boot }

  const field = opts.field || 'booting'
  const timeout = opts.timeout || DEFAULT_TIMEOUT
  // 页面漏声明 data.booting 时，首帧遮罩不会出现（show 为 undefined → 组件默认 false）。
  // 这里给一条警告帮助自查，但不自动补 setData —— onLoad 里的 setData 晚于首帧，补了反而白闪。
  if (ctx.data && ctx.data[field] !== true && opts.warn !== false) {
    console.warn('[boot] 页面未在 data 中声明 ' + field + ':true，遮罩可能不显示')
  }

  let pending = 0
  let closed = false
  let timer = null
  let zeroCheck = null   // 归零复查定时器（见 scheduleClose 注释）

  /**
   * 「归零」延迟复查。
   *
   * 为什么不能直接 finish：管理端页面的真实顺序是
   *   guard 建门 → 门禁回来 → release() → load() → hold()  ← 两步在同一个同步块里
   * 若在 release 当场就关闭遮罩，业务数据还没回来就露底了，抖动照旧。
   * 而且页面里的 `bootingFirst = !this._boot.closed` 会读到 closed=true，
   * 导致后续 hold/settle 全部被跳过——遮罩等于只盖了门禁那一跳。
   *
   * 排一个宏任务再复查 pending：微任务（await 续体）全部跑完后，
   * 若这一轮里又有人 hold（业务链开跑），pending 回升，取消关闭。
   */
  function scheduleClose(reason) {
    if (zeroCheck) return
    zeroCheck = setTimeout(() => {
      zeroCheck = null
      if (!closed && pending <= 0) finish(reason || 'done')
    }, 0)
  }

  function finish(reason) {
    if (closed) return
    closed = true
    if (timer) { clearTimeout(timer); timer = null }
    if (zeroCheck) { clearTimeout(zeroCheck); zeroCheck = null }
    const apply = () => { try { ctx.setData({ [field]: false }) } catch (e) { /* 页面已卸载 */ } }
    if (SLOW > 0) setTimeout(apply, SLOW); else apply()
  }

  timer = setTimeout(() => {
    console.warn('[boot] 就绪门超时（' + timeout + 'ms），强制关闭遮罩')
    finish('timeout')
  }, timeout)

  const api = {
    /** 声明「我在等 n 件事」（n 默认 1） */
    hold(n) {
      if (closed) return api
      const c = n === undefined ? 1 : n
      if (c > 0) pending += c
      return api
    },

    /**
     * 完成一件事；计数归零即关闭遮罩（延迟一拍复查，见 scheduleClose）。
     * ⚠️ 多余的 release（计数已为 0）会被忽略——不能让计数变负，
     *   否则下一次 hold 会把负数顶回 0 而误判为「就绪」。
     */
    release() {
      if (closed) return api
      if (pending <= 0) return api
      pending -= 1
      if (pending <= 0) scheduleClose('done')
      return api
    },

    /**
     * 帧收敛：等 depth 次 setData 渲染回调后再 release。
     * 专治「串行 setData 回调链」——回调里再 setData、再回调的链式更新，
     * 单纯 release 会在中间态就关掉遮罩。默认 depth=2（等价下一次渲染 + 再下一帧）。
     */
    settle(depth) {
      if (closed) return api
      let i = depth === undefined ? 2 : depth
      if (i <= 0) return api.release()
      const step = () => {
        if (closed) return
        i -= 1
        if (i <= 0) return api.release()
        try { ctx.setData({}, step) } catch (e) { finish('unload') }
      }
      try { ctx.setData({}, step) } catch (e) { finish('unload') }
      return api
    },

    /**
     * 包一个 Promise：无论 resolve 还是 reject 都记一次完成。
     * 这让各页原有 .catch 分支**无需改动**也能正确关闭遮罩。
     */
    add(p) {
      api.hold()
      Promise.resolve(p).then(() => api.release(), () => api.release())
      return p
    },

    /** 图片门：声明首屏有 n 张图要等（bindload / binderror 均算完成） */
    images(n) {
      const c = n || 0
      if (c > 0) api.hold(c)
      return api
    },

    /** 单张图完成（bindload 与 binderror 共用） */
    image() { return api.release() },

    /** 强制关闭：catch 分支 / 早退 return / 无权限 / 静态兜底 */
    close(reason) { finish(reason || 'force'); return api },

    get closed() { return closed },
    get pending() { return pending }
  }

  Object.defineProperty(ctx, '_boot', { value: api, writable: true, configurable: true, enumerable: false })
  return api
}

module.exports = createBoot
module.exports.ENABLED = ENABLED
module.exports.DEFAULT_TIMEOUT = DEFAULT_TIMEOUT
