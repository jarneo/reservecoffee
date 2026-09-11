// deploy/tests/listReviews.test.js — 审核页列表离线测试
// 重点锁住「前后端字段契约」：顾客按项目 fields 填写的补充信息（备注/微信/性别/年龄）
// 必须出现在返回值里，否则管理端页面会因为拿不到字段而整块不渲染（2026-09-12 的报障）。
// 用法：/Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node deploy/tests/listReviews.test.js
const { runFunction, makeChecker } = require('./harness')

const { check, state } = makeChecker()
const run = (setup) => runFunction('listReviews', setup, {})
// ⚠️ 云函数统一返回 { code, message, data }，业务数据在 res.data 下
const listOf = (res) => ((res && res.data && res.data.list) || [])

// 一笔「信息填满」的待审预约
const FULL = {
  _id: 'r1', openid: 'oCust', projectId: 'p1', sessionId: 's1', scheduleId: 'sch1',
  date: '2099-01-01', sessionStart: '10:00', sessionEnd: '11:30', partySize: 2,
  name: '张三', phone: '13800000001', status: 'pending', review: 'pending', createdAt: 1000,
  note: '带狗。五个人', wechat: 'zhangsan_wx', gender: '女', age: '28'
}

function base(s, over = {}) {
  s.openid = over.openid || 'oAdmin'
  s.cols.admins = over.admins !== undefined ? over.admins : { a1: { openid: 'oAdmin', role: 'owner' } }
  s.cols.projects = { p1: { _id: 'p1', name: '法兰绒深烘咖啡' } }
  s.cols.reservations = over.reservations || { r1: Object.assign({}, FULL) }
  s.cols.users = over.users || {}
}

;(async () => {
  console.log('\nR1 非管理员 → 拒绝')
  {
    const { res } = await run(s => base(s, { openid: 'oStranger', admins: {} }))
    check('返回失败', res.code !== 0, res)
  }

  console.log('\nR2 管理员 → 返回待审列表，且携带顾客补充字段（字段契约）')
  {
    const { res } = await run(s => base(s))
    const it = listOf(res)[0] || {}
    check('返回 1 条', listOf(res).length === 1, listOf(res))
    check('备注 note 有值', it.note === '带狗。五个人', it)
    check('微信 wechat 有值', it.wechat === 'zhangsan_wx', it)
    check('性别 gender 有值', it.gender === '女', it)
    check('年龄 age 有值', it.age === '28', it)
    check('项目名已关联', it.projectName === '法兰绒深烘咖啡', it)
    check('场次时间拼接', it.time === '10:00-11:30', it)
  }

  console.log('\nR3 字段缺失时返回空串（前端 wx:if 才能安全判空，不会渲染 undefined）')
  {
    const bare = Object.assign({}, FULL)
    delete bare.note; delete bare.wechat; delete bare.gender; delete bare.age
    const { res } = await run(s => base(s, { reservations: { r1: bare } }))
    const it = listOf(res)[0] || {}
    check('note 为空串', it.note === '', it)
    check('wechat 为空串', it.wechat === '', it)
    check('gender 为空串', it.gender === '', it)
    check('age 为空串', it.age === '', it)
  }

  console.log('\nR4 黑名单顾客 → 带 isBlacklisted + 原因（审核页标红提示）')
  {
    const { res } = await run(s => base(s, { users: { oCust: { _id: 'oCust', isBlacklisted: true, blacklistReason: '多次爽约' } } }))
    const it = listOf(res)[0] || {}
    check('isBlacklisted=true', it.isBlacklisted === true, it)
    check('拉黑原因透出', it.blacklistReason === '多次爽约', it)
  }

  console.log('\nR5 非待审 / 已取消的预约不进入审核列表')
  {
    const { res } = await run(s => base(s, {
      reservations: {
        r1: Object.assign({}, FULL),
        r2: Object.assign({}, FULL, { _id: 'r2', review: 'approved', status: 'confirmed' }),
        r3: Object.assign({}, FULL, { _id: 'r3', status: 'cancelled' })
      }
    }))
    check('只返回 1 条待审', listOf(res).length === 1, listOf(res).map(x => x._id))
    check('返回的是 r1', (listOf(res)[0] || {})._id === 'r1')
  }

  console.log(`\n===== 结果：通过 ${state.pass} / 失败 ${state.fail} =====`)
  process.exit(state.fail ? 1 : 0)
})().catch(e => { console.error('测试脚本自身出错：', e); process.exit(2) })
