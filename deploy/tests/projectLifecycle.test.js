// 项目生命周期 + 通知分配字段契约：新增项目默认全员 · updateProject 校验 · listProjects 回显
// 直接回应「新增项目怎么办」：新项目天然 notifyAdmins='all'（零丢单），店主可在矩阵里收窄。
const { runFunction, makeChecker } = require('./harness')

const { check, state } = makeChecker()

;(async () => {
  console.log('\n[A] createProject：新增项目默认 notifyAdmins="all"（零丢单，向后兼容现状）')
  {
    const r = await runFunction('createProject', s => {
      s.openid = 'oOwner'
      s.cols.admins = { a1: { _id: 'a1', openid: 'oOwner', role: 'owner' } }
    }, { event: { name: '新品·手冲', advanceDays: 7 } })
    check('owner 可建', r.res && r.res.code === 0, r.res)
    const id = r.res && r.res.data && r.res.data.id
    check('落库 notifyAdmins 缺省为 "all"', id && r.store.cols.projects[id] && r.store.cols.projects[id].notifyAdmins === 'all', id && r.store.cols.projects[id])
    check('非 owner 被拒', (await runFunction('createProject', s => {
      s.openid = 'oMgr'
      s.cols.admins = { a1: { _id: 'a1', openid: 'oOwner', role: 'owner' }, a2: { _id: 'a2', openid: 'oMgr', role: 'manager' } }
    }, { event: { name: 'x', advanceDays: 7 } })).res.code !== 0)
  }

  console.log('\n[B] updateProject：notifyAdmins 写入 / 校验')
  {
    const setup = s => {
      s.openid = 'oOwner'
      s.cols.admins = { a1: { _id: 'a1', openid: 'oOwner', role: 'owner' } }
      s.cols.projects = { P1: { _id: 'P1', name: '法兰绒', notifyAdmins: 'all' } }
    }
    // B1: 收窄为指定 openid 数组
    const r1 = await runFunction('updateProject', setup, { event: { projectId: 'P1', notifyAdmins: ['oA', 'oC'] } })
    check('owner 可收窄为数组', r1.res && r1.res.code === 0, r1.res)
    const w1 = r1.store.writes.find(x => x.name === 'projects' && x.id === 'P1')
    check('写库 notifyAdmins = ["oA","oC"]', w1 && JSON.stringify(w1.data.notifyAdmins) === JSON.stringify(['oA', 'oC']), w1 && w1.data)

    // B2: 恢复全员
    const r2 = await runFunction('updateProject', setup, { event: { projectId: 'P1', notifyAdmins: 'all' } })
    check('可恢复 "all"', r2.res && r2.res.code === 0 && r2.store.writes.find(x => x.id === 'P1').data.notifyAdmins === 'all', r2.res)

    // B3: 空数组 → 拒绝（避免误写「无人接收」静默丢单）
    const r3 = await runFunction('updateProject', setup, { event: { projectId: 'P1', notifyAdmins: [] } })
    check('空数组被拒', r3.res && r3.res.code !== 0, r3.res)

    // B4: 非法值（数字）→ 拒绝
    const r4 = await runFunction('updateProject', setup, { event: { projectId: 'P1', notifyAdmins: 123 } })
    check('非法值(123)被拒', r4.res && r4.res.code !== 0, r4.res)

    // B5: 缺省不传 → 不改（保留原值）
    const r5 = await runFunction('updateProject', setup, { event: { projectId: 'P1', name: '改名' } })
    const w5 = r5.store.writes.find(x => x.id === 'P1')
    check('不传 notifyAdmins → 不写入该字段（保留原值）', w5 && w5.data.notifyAdmins === undefined, w5 && Object.keys(w5.data))
  }

  console.log('\n[C] listProjects：回显 notifyAdmins（前端矩阵/概览依赖此字段）')
  {
    const r = await runFunction('listProjects', s => {
      s.openid = 'oOwner'
      s.cols.admins = { a1: { _id: 'a1', openid: 'oOwner', role: 'owner' } }
      s.cols.projects = {
        P1: { _id: 'P1', name: '法兰绒', notifyAdmins: 'all', published: true },
        P2: { _id: 'P2', name: '清酒', notifyAdmins: ['oA', 'oC'], published: true },
        P3: { _id: 'P3', name: '缺字段', published: true }   // 缺 notifyAdmins → 回显 'all'
      }
    })
    check('owner 可查', r.res && r.res.code === 0, r.res)
    const map = {}
    for (const p of (r.res.data.list || [])) map[p._id] = p.notifyAdmins
    check('P1 回显 "all"', map.P1 === 'all', map)
    check('P2 回显 ["oA","oC"]', JSON.stringify(map.P2) === JSON.stringify(['oA', 'oC']), map.P2)
    check('P3 缺字段 → 回显 "all"（前端不崩）', map.P3 === 'all', map.P3)
  }

  console.log('\n' + (state.fail === 0 ? '全部通过' : '有失败') + '：' + state.pass + ' passed, ' + state.fail + ' failed')
  if (state.fail > 0) process.exit(1)
})().catch(e => { console.error('测试异常:', e); process.exit(1) })
