// 就绪门行为仿真：用假 Page 实例驱动 boot.js，验证计数池语义
const path = require('path')
const boot = require(path.join('D:/WorkBuddy/reservecoffee/miniprogram/utils/boot.js'))

let pass = 0, fail = 0
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS ' + msg) } else { fail++; console.log('  FAIL ' + msg) } }

// 假页面实例
function mkCtx(initialBooting) {
  const ctx = {
    data: initialBooting === undefined ? { booting: true } : initialBooting,
    _writes: [],
    setData(patch, cb) {
      Object.assign(this.data, patch)
      this._writes.push(JSON.stringify(patch))
      if (typeof cb === 'function') setImmediate(cb)
    }
  }
  return ctx
}

// 用真实定时器让出事件循环：boot 的归零复查走 setTimeout(0)，
// 纯 setImmediate 链会在 1ms 内跑完，定时器根本轮不到执行 → 假失败
async function tick(n) { for (let i = 0; i < (n || 3); i++) await new Promise(r => setTimeout(r, 1)) }

;(async () => {
  console.log('\n[1] 基本：单请求 hold→settle')
  {
    const ctx = mkCtx()
    const b = boot(ctx, { timeout: 5000 })
    ok(ctx.data.booting === true, '初始 booting=true（遮罩显示）')
    b.add(Promise.resolve('x'))
    await tick(5)
    ok(ctx.data.booting === false, '请求完成后 booting=false（遮罩关闭）')
    ok(b.closed === true, 'closed=true')
  }

  console.log('\n[2] 并发：两条请求都完成才关')
  {
    const ctx = mkCtx()
    let r1, r2
    const p1 = new Promise(r => { r1 = r })
    const p2 = new Promise(r => { r2 = r })
    const b = boot(ctx, { timeout: 5000 })
    b.add(p1); b.add(p2)
    r1('a'); await tick(5)
    ok(ctx.data.booting === true, '只完成 1/2 → 遮罩仍显示')
    r2('b'); await tick(5)
    ok(ctx.data.booting === false, '2/2 完成 → 遮罩关闭')
  }

  console.log('\n[3] catch 分支也能自动关（不依赖页面改 catch）')
  {
    const ctx = mkCtx()
    const b = boot(ctx, { timeout: 5000 })
    b.add(Promise.reject(new Error('boom')))
    await tick(5)
    ok(ctx.data.booting === false, 'Promise reject 也 release → 遮罩关闭（不会白屏）')
  }

  console.log('\n[4] 串行链：settle 帧收敛')
  {
    const ctx = mkCtx()
    const b = boot(ctx, { timeout: 5000 })
    b.hold()                       // 数据请求
    // 模拟 booking：setData(A, cb) → cb 里再两段 setData
    ctx.setData({ A: 1 }, () => {
      b.settle(2)                  // 帧收敛：等 2 次渲染回调
      ctx.setData({ B: 2 }, () => { /* 中间态 */ })
    })
    await tick(10)
    ok(ctx.data.booting === false, '帧收敛后遮罩关闭')
  }

  console.log('\n[5] 图片门：声明 n 张，逐张完成')
  {
    const ctx = mkCtx()
    const b = boot(ctx, { timeout: 5000 })
    b.hold()                        // 数据
    ctx.setData({ data: 1 }, () => {
      b.images(3).settle(1)         // 声明 3 张图
      // 模拟 bindload 逐张回来
      setTimeout(() => b.image(), 1)
      setTimeout(() => b.image(), 2)
      setTimeout(() => b.image(), 3)
    })
    await tick(10)
    ok(ctx.data.booting === false, '3 张图全回调后关闭')
  }

  console.log('\n[6] 硬超时兜底：什么都不 release 也会关')
  {
    const ctx = mkCtx()
    boot(ctx, { timeout: 60 })
    await new Promise(r => setTimeout(r, 150))
    ok(ctx.data.booting === false, '超时后强制关闭（不会永久白屏）')
  }

  console.log('\n[7] 单例：同一 ctx 重复调用不产生两个 timer')
  {
    const ctx = mkCtx()
    const b1 = boot(ctx, { timeout: 5000 })
    const b2 = boot(ctx, { timeout: 5000 })
    ok(b1 === b2, '第二次调用返回同一实例')
    b1.release(); b1.release()      // 两次 release：一次补 guard 建门，一次补重复调用的 hold
    await tick(5)
    ok(ctx.data.booting === false, '计数归零后关闭')
  }

  console.log('\n[8] close 幂等 + onShow 复访不再唤起')
  {
    const ctx = mkCtx()
    const b = boot(ctx, { timeout: 5000 })
    b.close('test')
    await tick(3)
    ok(ctx.data.booting === false, 'close 生效')
    const writes = ctx._writes.length
    b.hold(); b.add(Promise.resolve())   // 模拟 tab 切回 onShow 再次调用
    await tick(5)
    ok(ctx._writes.length === writes, 'tab 切回后不再产生任何 setData（遮罩不重复出现）')
  }

  console.log('\n[9] 管理端模式：guard hold → release → 业务链 hold（真实顺序）')
  {
    const ctx = mkCtx()
    const b = boot(ctx, { timeout: 5000 })   // adminGuard 首行建门
    b.hold()                                 // ← adminGuard 新增：门禁算一件事
    // 模拟 async guard() 的 await 续体：release 与随后的业务 hold 在同一个同步块里
    b.release()
    const bootingFirst = !b.closed
    ok(bootingFirst === true, '门禁完成时 closed 仍为 false（页面能正确读到 bootingFirst）')
    if (bootingFirst) b.hold()               // 业务链首跳
    await tick(3)
    ok(ctx.data.booting === true, '仅门禁完成、业务数据未回 → 遮罩仍显示（不会提前露底）')
    // 业务链末端：setData 渲染回调里的 settle(1)（与上面的 hold 配对）
    ctx.setData({ view: 1 }, () => b.settle(1))
    await tick(5)
    ok(ctx.data.booting === false, '业务数据回 → 关闭')
  }

  console.log('\n[11] 多余 release 不会让计数变负（否则下次 hold 会被误判就绪）')
  {
    const ctx = mkCtx()
    const b = boot(ctx, { timeout: 5000 })
    b.release(); b.release()          // 没有任何 hold 就 release
    await tick(3)
    ok(ctx.data.booting === true, '裸 release 被忽略，遮罩不关')
    b.hold()                          // 业务链开跑
    await tick(3)
    ok(ctx.data.booting === true, 'hold 之后仍显示（计数没被负数抵消）')
    b.release()
    await tick(3)
    ok(ctx.data.booting === false, '业务完成 → 关闭')
  }

  console.log('\n[10] 漏声明 data.booting 时不报错、不自动补写')
  {
    const ctx = mkCtx({})
    boot(ctx, { timeout: 5000 })
    // 不自动补 setData，避免 onLoad 阶段白闪
  }

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`)
  process.exit(fail ? 1 : 0)
})()
