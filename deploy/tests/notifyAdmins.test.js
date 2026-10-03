// notifyAdmins / resolveNotifyScope 离线单测（项目维度收窄核心逻辑）
// 覆盖：resolveNotifyScope 归一化 · notifyAdmins 按名单收窄 · 订阅失效跳过 · 43101 回写 ·
//       向后兼容（历史缺 subscriptions 管理员不被误拦）· 空数组兜底全员
const { loadLibWithDb, makeChecker } = require('./harness')

const { check, state } = makeChecker()

;(async () => {
  console.log('\n[A] resolveNotifyScope / normalizeNotifyAdmins / inNotifyScope：归一化（缺省/all/数组/非法/空数组）')
  {
    const { lib } = loadLibWithDb()
    check('inNotifyScope(null) → true', lib.inNotifyScope(null, 'oX') === true)
    check('inNotifyScope("all") → true', lib.inNotifyScope('all', 'oX') === true)
    check('inNotifyScope(123) → true（非法值兜底全员）', lib.inNotifyScope(123, 'oX') === true)
    check('inNotifyScope([]) → true（空数组兜底全员，与 notifyAdmins 同源）', lib.inNotifyScope([], 'oX') === true)
    check('inNotifyScope(["oA","oC"], "oB") → false（名单内不含）', lib.inNotifyScope(['oA', 'oC'], 'oB') === false)
    check('inNotifyScope(["oA","oC"], "oC") → true（名单内含）', lib.inNotifyScope(['oA', 'oC'], 'oC') === true)
    check('inNotifyScope(["oA",""], "oA") → true（脏空串被过滤仍可命中）', lib.inNotifyScope(['oA', ''], 'oA') === true)
  }

  console.log('\n[B] notifyAdmins：按项目名单收窄（核心新增行为）')
  {
    const admins = {
      aA: { _id: 'aA', openid: 'oA', role: 'owner', nickname: '倪师傅' },
      aB: { _id: 'aB', openid: 'oB', role: 'manager', nickname: '苏打' },
      aC: { _id: 'aC', openid: 'oC', role: 'manager', nickname: '棠棠' }
    }
    const { lib, db, store } = loadLibWithDb(s => {
      s.cols.admins = admins
      s.cols.projects = {
        P1: { _id: 'P1', notifyAdmins: 'all' },
        P2: { _id: 'P2', notifyAdmins: ['oA', 'oC'] }
      }
    })
    // B1: projectId=P1(all) → 3 人全收
    await lib.notifyAdmins(db, { projectId: 'P1', templateId: lib.TPL.adminNew, data: {} })
    const got1 = store.subscribeCalls.map(c => c.touser).sort()
    check('P1(all) → 3 人全收', got1.join(',') === 'oA,oB,oC', got1)
    store.subscribeCalls.length = 0

    // B2: projectId=P2(list [oA,oC]) → 只有 oA,oC；oB 被 not-in-project-scope 跳过（不消耗额度）
    const r2 = await lib.notifyAdmins(db, { projectId: 'P2', templateId: lib.TPL.adminNew, data: {} })
    const got2 = store.subscribeCalls.map(c => c.touser).sort()
    check('P2(list) → 只收 oA,oC', got2.join(',') === 'oA,oC', got2)
    const skipB = r2.find(x => x.openid === 'oB')
    check('P2(list) → oB 被 not-in-project-scope 跳过', !!(skipB && skipB.reason === 'not-in-project-scope' && skipB.skipped === true), skipB)
    check('P2(list) → 仅 2 条真正发送', r2.filter(x => x.ok).length === 2, r2)
    store.subscribeCalls.length = 0

    // B3: 无 projectId → 兜底 all → 3 人全收（向后兼容旧调用）
    await lib.notifyAdmins(db, { templateId: lib.TPL.adminNew, data: {} })
    check('无 projectId → 兜底全收 3 人', store.subscribeCalls.length === 3, store.subscribeCalls)
    store.subscribeCalls.length = 0

    // B4: 空数组项目 → 兜底全员（修复 notifyAdmins 与 getInbox 错位丢单）
    store.cols.projects.P3 = { _id: 'P3', notifyAdmins: [] }
    await lib.notifyAdmins(db, { projectId: 'P3', templateId: lib.TPL.adminNew, data: {} })
    check('空数组项目 → 兜底全收 3 人（不丢单）', store.subscribeCalls.map(c => c.touser).sort().join(',') === 'oA,oB,oC', store.subscribeCalls)
  }

  console.log('\n[C] notifyAdmins：订阅失效跳过（adminSubbedOf）+ 43101 回写失效')
  {
    const { lib, db, store } = loadLibWithDb(s => {
      s.cols.admins = {
        aA: { _id: 'aA', openid: 'oA', role: 'owner' },
        aB: { _id: 'aB', openid: 'oB', role: 'manager', subscriptions: { adminNew: false } } // oB 拒收 adminNew
      }
      s.cols.projects = { P1: { _id: 'P1', notifyAdmins: 'all' } }
    })
    // C1: adminNew 模板，oB 已拒收 → 跳过 subscription marked invalid
    const r1 = await lib.notifyAdmins(db, { projectId: 'P1', templateId: lib.TPL.adminNew, data: {} })
    const got = store.subscribeCalls.map(c => c.touser).sort()
    check('oB 拒收 adminNew → 只发 oA', got.join(',') === 'oA', got)
    const skipB = r1.find(x => x.openid === 'oB')
    check('oB → subscription marked invalid', !!(skipB && skipB.reason === 'subscription marked invalid'), skipB)
    store.subscribeCalls.length = 0

    // C2: 43101 → 回写 markAdminSubInvalid（subscriptions.adminNew=false + lastErrorKey）
    store.wx.failTemplates = [lib.TPL.adminNew]
    await lib.notifyAdmins(db, { projectId: 'P1', templateId: lib.TPL.adminNew, data: {} })
    const w = store.writes.find(x => x.name === 'admins' && x.id === 'aA')
    check('43101 → aA 被标记 adminNew 失效（点路径不整覆盖）',
      !!(w && w.data['subscriptions.adminNew'] === false && w.data.lastErrorKey === 'adminNew'), w && w.data)
  }

  console.log('\n[D] notifyAdmins：向后兼容（历史缺 subscriptions 管理员不被误拦）')
  {
    const { lib, db, store } = loadLibWithDb(s => {
      s.cols.admins = {
        aA: { _id: 'aA', openid: 'oA', role: 'owner' },          // 无 subscriptions（存量）
        aB: { _id: 'aB', openid: 'oB', role: 'manager' }         // 无 subscriptions
      }
      s.cols.projects = { P1: { _id: 'P1', notifyAdmins: 'all' } }
    })
    await lib.notifyAdmins(db, { projectId: 'P1', templateId: lib.TPL.adminCancel, data: {} })
    check('历史管理员缺 subscriptions → 仍全收（缺省开）',
      store.subscribeCalls.map(c => c.touser).sort().join(',') === 'oA,oB', store.subscribeCalls)
  }

  console.log('\n[E] notifyAdmins：模板未配置（TPL_ID_ 占位）→ 整体跳过，不触达')
  {
    const { lib, db, store } = loadLibWithDb(s => {
      s.cols.admins = { aA: { _id: 'aA', openid: 'oA', role: 'owner' } }
      s.cols.projects = { P1: { _id: 'P1', notifyAdmins: 'all' } }
    })
    const r = await lib.notifyAdmins(db, { projectId: 'P1', templateId: 'TPL_ID_PLACEHOLDER', data: {} })
    check('占位模板 → 返回 skipped（不触达）', store.subscribeCalls.length === 0 && r[0] && r[0].skipped === true, r)
  }

  console.log('\n' + (state.fail === 0 ? '全部通过' : '有失败') + '：' + state.pass + ' passed, ' + state.fail + ' failed')
  if (state.fail > 0) process.exit(1)
})().catch(e => { console.error('测试异常:', e); process.exit(1) })
