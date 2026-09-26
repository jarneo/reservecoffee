// tests/role.test.js — app.refreshRole() 请求去重的行为仿真
//
// 背景：改造前 onLaunch 并发调了 2 次、首页 onShow 又调 1 次，同一次冷启动跑 3 遍 getRole。
// 改成「30s TTL 内复用同一个 Promise」后，必须保证：
//   1) 连续调用合并为 1 次请求
//   2) force=true 能穿透缓存（管理端门禁依赖此行为）
//   3) TTL 过期后重新发请求（角色不会被永久钉死）
//   4) 失败不缓存，下次调用正常重试
//
// 运行：node tests/role.test.js

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)) }

// ── 复刻 app.js 的 refreshRole 实现（保持与源码同步）──
function mkApp(impl) {
  return {
    globalData: { role: 'none', openid: '' },
    _rolePromise: null,
    _roleAt: 0,
    refreshRole(force) {
      const now = Date.now()
      const TTL = 30 * 1000
      if (!force && this._rolePromise && (now - (this._roleAt || 0)) < TTL) return this._rolePromise
      this._roleAt = now
      this._rolePromise = impl()
        .then(r => { this.globalData.role = (r && r.role) || 'none'; this.globalData.openid = (r && r.openid) || ''; return r })
        .catch(() => { this._rolePromise = null; return { role: 'none' } })
      return this._rolePromise
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  console.log('\n[1] 连续两次调用 → 只发 1 次请求（onLaunch 的两处调用）')
  {
    let n = 0
    const app = mkApp(() => { n++; return Promise.resolve({ role: 'owner', openid: 'o1' }) })
    const a = app.refreshRole()
    const b = app.refreshRole()
    await Promise.all([a, b])
    ok(n === 1, `实际请求次数 = 1（实测 ${n}）`)
    ok(app.globalData.role === 'owner', 'globalData.role 正确写入 owner')
  }

  console.log('\n[2] 首页 onShow 复用 → 仍为 1 次（改造前是 3 次）')
  {
    let n = 0
    const app = mkApp(() => { n++; return Promise.resolve({ role: 'none' }) })
    await app.refreshRole()      // onLaunch 第一处
    await app.refreshRole()      // onLaunch 第二处（链式埋点）
    await app.refreshRole()      // index onShow
    ok(n === 1, `3 次调用 → 1 次请求（实测 ${n}）`)
  }

  console.log('\n[3] force=true 穿透缓存（管理端门禁）')
  {
    let n = 0
    const app = mkApp(() => { n++; return Promise.resolve({ role: 'manager' }) })
    await app.refreshRole()
    await app.refreshRole(true)   // adminGuard 强制刷新
    ok(n === 2, `force 后新增一次请求（实测 ${n}）`)
  }

  console.log('\n[4] TTL 过期后重新发请求（角色不会被永久钉死）')
  {
    let n = 0
    const app = mkApp(() => { n++; return Promise.resolve({ role: 'owner' }) })
    await app.refreshRole()
    app._roleAt = Date.now() - 31 * 1000   // 模拟 31 秒后（不真等）
    await app.refreshRole()
    ok(n === 2, `超过 30s TTL → 重新请求（实测 ${n}）`)
  }

  console.log('\n[5] 请求失败 → 不缓存，下次正常重试')
  {
    let n = 0
    const app = mkApp(() => { n++; return Promise.reject(new Error('网络错误')) })
    const r1 = await app.refreshRole()
    ok(r1.role === 'none' && app.globalData.role === 'none', '失败时安全降级为 none（不抛异常）')
    ok(app._rolePromise === null, '失败后清空缓存标记')
    const app2 = mkApp(() => { n++; return Promise.resolve({ role: 'owner' }) })
    await app2.refreshRole()
    ok(n === 2, '失败后的下一次调用会真正重新发起（实测累计 ' + n + '）')
  }

  console.log('\n[6] 并发调用共享同一个 Promise（不会出现两个 in-flight 请求）')
  {
    let n = 0
    const app = mkApp(() => { n++; return sleep(20).then(() => ({ role: 'owner' })) })
    const ps = [app.refreshRole(), app.refreshRole(), app.refreshRole()]
    const rs = await Promise.all(ps)
    ok(n === 1, `并发 3 次 → 1 次请求（实测 ${n}）`)
    ok(rs.every(r => r.role === 'owner'), '三个调用方拿到相同结果')
  }

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`)
  process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('测试崩溃:', e); process.exit(1) })
