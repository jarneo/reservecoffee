// getInbox 离线测试：项目维度收窄（列表/未读/总数/详情越权守卫）
// 覆盖：列表只展示当前管理员可接收范围 · 无 projectId 旧留痕可见 ·
//       详情越权守卫（被收窄管理员看不到范围外项目通知）· 空数组兜底全员（与 notifyAdmins 同源）
const { runFunction, makeChecker } = require('./harness')

const { check, state } = makeChecker()

const ADMINS = {
  aA: { _id: 'aA', openid: 'oA', role: 'owner', nickname: '倪师傅' },
  aB: { _id: 'aB', openid: 'oB', role: 'manager', nickname: '苏打' }   // 被 P2 排除
}
const PROJECTS = {
  P1: { _id: 'P1', name: '法兰绒深烘', notifyAdmins: 'all' },
  P2: { _id: 'P2', name: '清酒品鉴', notifyAdmins: ['oA', 'oC'] },     // 排除 oB
  P3: { _id: 'P3', name: '经典名店' },                                  // 缺字段 → 全员
  P4: { _id: 'P4', name: '非法值', notifyAdmins: 123 },                // 非法 → 全员
  P5: { _id: 'P5', name: '空数组', notifyAdmins: [] },                 // 空数组 → 全员（兜底）
  P6: { _id: 'P6', name: '指定 oB', notifyAdmins: ['oB'] }             // 仅 oB 在范围
}
// 每个项目各放一条收件箱通知（new 类型），另放 2 条无 projectId 的旧留痕
function inboxSeed() {
  const seed = {}
  let n = 0
  for (const pid of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
    n++
    seed['i' + pid] = {
      _id: 'i' + pid, type: 'new', projectId: pid, projectName: PROJECTS[pid].name,
      createdAt: n, readBy: [], resId: 'r' + pid, customerName: '客' + pid, count: 2
    }
  }
  seed.legacy1 = { _id: 'legacy1', type: 'new', createdAt: 100, readBy: [], customerName: '老客A' }
  seed.legacy2 = { _id: 'legacy2', type: 'cancel', createdAt: 101, readBy: [], customerName: '老客B' }
  return seed
}

// 以某管理员身份跑 getInbox
async function getInboxAs(openid, event) {
  return runFunction('getInbox', s => {
    s.openid = openid
    s.cols.admins = ADMINS
    s.cols.projects = PROJECTS
    s.cols.adminInbox = inboxSeed()
  }, { event: event || {} })
}

;(async () => {
  console.log('\n[1] 列表范围：oB（被 P2 排除，其余都在）→ 看不到 P2，看得到 P1/P3/P4/P5/P6 + 2 条旧留痕')
  {
    const { res } = await getInboxAs('oB', {})
    check('返回 code===0', res && res.code === 0, res)
    const ids = res.data.list.map(x => x._id).sort()
    check('不含 iP2（被收窄）', ids.indexOf('iP2') < 0, ids)
    check('含 iP1/iP3/iP4/iP5/iP6', ['iP1', 'iP3', 'iP4', 'iP5', 'iP6'].every(id => ids.indexOf(id) >= 0), ids)
    check('含 legacy1/legacy2（无 projectId 宽松可见）', ids.indexOf('legacy1') >= 0 && ids.indexOf('legacy2') >= 0, ids)
    check('total = 7（5 在范围项目 + 2 旧留痕）', res.data.total === 7, res.data.total)
  }

  console.log('\n[2] 列表范围：oA（P2 包含，但 P6 仅 oB → 被排除）')
  {
    const { res } = await getInboxAs('oA', {})
    const ids = res.data.list.map(x => x._id).sort()
    check('含 iP2（oA 在 P2 名单）', ids.indexOf('iP2') >= 0, ids)
    check('不含 iP6（P6 仅 oB 在范围）', ids.indexOf('iP6') < 0, ids)
    check('total = 7（P1/P2/P3/P4/P5 共 5 项目 + 2 旧留痕；P6 排除）', res.data.total === 7, res.data.total)
  }

  console.log('\n[3] 空数组兜底：P5 对 oB 也可见（与 notifyAdmins 同源，避免发了看不到）')
  {
    const { res } = await getInboxAs('oB', {})
    check('iP5 可见（空数组兜底全员）', res.data.list.map(x => x._id).indexOf('iP5') >= 0, res.data.list.map(x => x._id))
  }

  console.log('\n[4] 详情越权守卫：oB 看 P2 通知 → 被拒；oA 看 P2 通知 → 通过')
  {
    const rB = await getInboxAs('oB', { id: 'iP2' })
    check('oB 看 iP2 详情 → 无权（被收窄）', rB.res && rB.res.code !== 0, rB.res)
    const rA = await getInboxAs('oA', { id: 'iP2' })
    check('oA 看 iP2 详情 → 通过', rA.res && rA.res.code === 0 && rA.res.data.item && rA.res.data.item._id === 'iP2', rA.res)
  }

  console.log('\n[5] 详情越权守卫：oB 看 P6（仅 oB 在范围）通知 → 通过')
  {
    const rB = await getInboxAs('oB', { id: 'iP6' })
    check('oB 看 iP6 详情 → 通过（在范围）', rB.res && rB.res.code === 0, rB.res)
    const rA = await getInboxAs('oA', { id: 'iP6' })
    check('oA 看 iP6 详情 → 无权（不在范围）', rA.res && rA.res.code !== 0, rA.res)
  }

  console.log('\n[6] 无 id：未读/总数按范围统计，与列表一致（不越权）')
  {
    const { res } = await getInboxAs('oB', {})
    check('total 与 list 长度一致（无分页溢出时）', res.data.total === res.data.list.length, { total: res.data.total, len: res.data.list.length })
    check('未读数 ≥ 0 且 ≤ total', res.data.unread >= 0 && res.data.unread <= res.data.total, res.data.unread)
  }

  console.log('\n' + (state.fail === 0 ? '全部通过' : '有失败') + '：' + state.pass + ' passed, ' + state.fail + ' failed')
  if (state.fail > 0) process.exit(1)
})().catch(e => { console.error('测试异常:', e); process.exit(1) })
