// deploy/tests/listMyReservations.test.js — 顾客端「我的预约」五态判定回归测试
// 重点守：**过期判定必须与容器时区无关**。
//   SCF 容器时区是 UTC，而 date/sessionEnd 存的是北京时间；若用 new Date('2026-09-11 20:00')
//   解析，会被当成「北京 09-12 04:00」，导致前一天晚上结束的预约到次日凌晨仍显示「预约成功」。
//   本文件请分别在两个时区各跑一遍，两遍都必须全绿：
//     TZ=UTC                node deploy/tests/listMyReservations.test.js
//     TZ=Asia/Shanghai      node deploy/tests/listMyReservations.test.js
const { runFunction, makeChecker, bjNow, plusDays } = require('./harness')

const { check, state } = makeChecker()
const run = (setup) => runFunction('listMyReservations', setup, { event: {} })

const bj = bjNow()
const TODAY = bj.date
const YDAY = plusDays(TODAY, -1)
const TMRW = plusDays(TODAY, 1)

// 每个用例一个独立预约
function base(s, rows) {
  s.openid = 'oCust'
  s.cols.reservations = {}
  rows.forEach((r, i) => { s.cols.reservations['r' + (i + 1)] = Object.assign({ _id: 'r' + (i + 1), openid: 'oCust', projectId: 'p1', partySize: 1 }, r) })
  s.cols.projects = { p1: { _id: 'p1', name: '法兰绒深烘咖啡预约' } }
}
const byId = (store, id) => (store.res && store.res.data.list) || []

;(async () => {
  console.log(`\n（当前进程时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}；北京今天 ${TODAY}）`)

  console.log('\nL1 昨天的场次 → 已过期（早场/晚场都必须过期）')
  {
    const rows = [
      { date: YDAY, sessionStart: '10:00', sessionEnd: '11:30', status: 'confirmed' },
      { date: YDAY, sessionStart: '20:00', sessionEnd: '22:00', status: 'confirmed' }, // UTC 容器下旧的字符串解析会误判
      { date: YDAY, sessionStart: '16:30', sessionEnd: '18:00', status: 'confirmed' }
    ]
    const { res } = await run(s => base(s, rows))
    const list = (res.data && res.data.list) || []
    check('返回 3 条', list.length === 3, list.length)
    check('昨天 10:00-11:30 → expired', list[0] && list[0].status === 'expired', list[0])
    check('昨天 20:00-22:00 → expired', list[1] && list[1].status === 'expired', list[1])
    check('昨天 16:30-18:00 → expired', list[2] && list[2].status === 'expired', list[2])
    check('过期后不可再取消', list.every(x => x.canCancel === false), list.map(x => x.canCancel))
  }

  console.log('\nL2 明天的场次 → 保持原状态（confirmed / pending）且可取消')
  {
    const rows = [
      { date: TMRW, sessionStart: '10:00', sessionEnd: '11:30', status: 'confirmed' },
      { date: TMRW, sessionStart: '18:00', sessionEnd: '20:00', status: 'pending' }
    ]
    const { res } = await run(s => base(s, rows))
    const list = (res.data && res.data.list) || []
    check('明天 confirmed 仍为 confirmed', list[0] && list[0].status === 'confirmed', list[0])
    check('明天 pending 仍为 pending', list[1] && list[1].status === 'pending', list[1])
    check('未过期可取消', list.every(x => x.canCancel === true), list.map(x => x.canCancel))
  }

  console.log('\nL3 cancelled / completed 优先于时间判定（即使日期已过）')
  {
    const rows = [
      { date: YDAY, sessionStart: '10:00', sessionEnd: '11:30', status: 'cancelled' },
      { date: YDAY, sessionStart: '10:00', sessionEnd: '11:30', status: 'completed' }
    ]
    const { res } = await run(s => base(s, rows))
    const list = (res.data && res.data.list) || []
    check('cancelled → cancelled', list[0] && list[0].status === 'cancelled', list[0])
    check('completed → completed', list[1] && list[1].status === 'completed', list[1])
    check('两者都不可取消', list.every(x => x.canCancel === false), list.map(x => x.canCancel))
  }

  console.log('\nL4 边界：sessionEnd 缺失按 23:59 处理；非法值保守返回原状态（不误判过期）')
  {
    const rows = [
      { date: YDAY, sessionStart: '10:00', status: 'confirmed' },                                  // 缺 sessionEnd → 昨天 23:59 → 已过
      { date: '2099-01-01', sessionStart: '10:00', sessionEnd: 'abc', status: 'confirmed' },        // 非法 → 保守
      { date: 'bad-date', sessionStart: '10:00', sessionEnd: '11:30', status: 'confirmed' }         // 日期非法 → 保守
    ]
    const { res } = await run(s => base(s, rows))
    const list = (res.data && res.data.list) || []
    check('缺 sessionEnd 的昨天场次 → expired', list[0] && list[0].status === 'expired', list[0])
    check('非法 sessionEnd → 不误判（confirmed）', list[1] && list[1].status === 'confirmed', list[1])
    check('非法 date → 不误判（confirmed）', list[2] && list[2].status === 'confirmed', list[2])
  }

  console.log('\nL5 关联项目名 & 只返回自己的预约')
  {
    const { res } = await run(s => {
      base(s, [{ date: TMRW, sessionStart: '10:00', sessionEnd: '11:30', status: 'confirmed' }])
      s.cols.reservations.rOther = { _id: 'rOther', openid: 'oSomeoneElse', projectId: 'p1', date: TMRW, sessionStart: '10:00', sessionEnd: '11:30', status: 'confirmed' }
    })
    const list = (res.data && res.data.list) || []
    check('只返回本人 1 条', list.length === 1, list.length)
    check('带出项目名', list[0] && list[0].projectName === '法兰绒深烘咖啡预约', list[0])
    check('时间格式化 "10:00–11:30"', list[0] && list[0].time === '10:00–11:30', list[0] && list[0].time)
  }

  console.log('\nL6 无 openid → 空列表（不报错）')
  {
    const { res } = await run(s => { base(s, []); s.openid = '' })
    check('code=0 且 list 为空', res.code === 0 && (res.data.list || []).length === 0, res)
  }

  console.log(`\n===== 结果：通过 ${state.pass} / 失败 ${state.fail} =====`)
  process.exit(state.fail ? 1 : 0)
})().catch(e => { console.error('测试脚本自身出错：', e); process.exit(2) })
