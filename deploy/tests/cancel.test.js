// deploy/tests/cancel.test.js — cancelReservation 离线集成测试（取消短信「延迟计划」分支矩阵）
// 用法：/Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node deploy/tests/cancel.test.js
const { runFunction, makeChecker, bjNow, plusDays, hhmmFromMin } = require('./harness')

const { check, state } = makeChecker()
const run = (setup, event) => runFunction('cancelReservation', setup, { event })

const RES = {
  _id: 'r1', openid: 'oCust', projectId: 'p1', scheduleId: 'sch1', sessionId: 's1',
  date: '2099-01-01', sessionStart: '09:00', sessionEnd: '10:30', partySize: 2,
  name: '张三', phone: '13800000001', status: 'confirmed'
}

function base(s, over = {}) {
  s.cols.config = {
    smsnotify: Object.assign({ cancel: true, cancelDelay: 3, skipSmsIfWxOk: false }, over.smsnotify || {}),
    subscribe: Object.assign({ reserveCancel: true, adminCancel: true }, over.subscribe || {})
  }
  s.smsTemplates = over.smsTemplates !== undefined ? over.smsTemplates : { cancel: '2729679' }
  // cancelReservation 直读 config_sms 集合判断「是否已配置取消模板」（不依赖短信 SDK）
  s.cols.config_sms = { sms: { templates: over.smsTemplates !== undefined ? over.smsTemplates : { cancel: '2729679' } } }
  s.cols.projects = { p1: { _id: 'p1', name: '法兰绒深烘咖啡', smsEnabled: over.smsEnabled !== false } }
  s.cols.reservations = { r1: Object.assign({}, RES, over.reservation || {}) }
  s.openid = over.openid || 'oCust'
}

;(async () => {
  const now = Date.now()

  console.log('\nC1 降级开关开 + 微信送达 → 不安排取消短信')
  {
    const { store, res } = await run(s => base(s, { smsnotify: { skipSmsIfWxOk: true } }), { reservationId: 'r1' })
    check('取消成功', res.code === 0, res)
    check('顾客收到 reserveCancel 订阅', store.subscribeCalls.some(c => c.touser === 'oCust'))
    check('未写 smsCancelAt', !store.writes.some(w => w.data.smsCancelAt !== undefined), store.writes)
    check('plan = wx delivered skipped', store.writes.some(w => w.data.cancelSmsPlan && w.data.cancelSmsPlan.skipped === true && /wx subscribe delivered/.test(w.data.cancelSmsPlan.reason)), store.writes.map(w => w.data.cancelSmsPlan))
    check('订单状态置 cancelled', (store.cols.reservations.r1 || {}).status === 'cancelled')
  }

  console.log('\nC2 降级开关关 → 安排延迟取消短信（默认 3 分钟）')
  {
    const { store } = await run(s => base(s), { reservationId: 'r1' })
    const w = store.writes.find(w => w.data.smsCancelAt !== undefined)
    check('写入 smsCancelAt', !!w)
    check('smSCancelSent=false', w && w.data.smsCancelSent === false, w && w.data)
    check('延迟约 3 分钟', w && Math.abs(w.data.smsCancelAt - (now + 3 * 60000)) < 5000, w && (w.data.smsCancelAt - now))
    check('plan.scheduledIn=3', store.writes.some(x => x.data.cancelSmsPlan && x.data.cancelSmsPlan.scheduledIn === 3), store.writes.map(x => x.data.cancelSmsPlan))
    check('本函数不直接发短信（由定时任务承担）', store.smsCalls.length === 0, store.smsCalls)
  }

  console.log('\nC3 微信未送达（43101）+ 降级开关开 → 短信兜底仍安排')
  {
    const { store } = await run(s => { base(s, { smsnotify: { skipSmsIfWxOk: true } }); s.wx.errCode = 43101 }, { reservationId: 'r1' })
    check('落库 cancelNotify.errCode=43101', store.writes.some(w => w.data.cancelNotify && w.data.cancelNotify.errCode === 43101), store.writes.map(w => w.data.cancelNotify))
    check('仍安排取消短信', store.writes.some(w => w.data.smsCancelAt !== undefined), store.writes)
  }

  console.log('\nC4 全局取消短信开关关闭 → 不发不排')
  {
    const { store } = await run(s => base(s, { smsnotify: { cancel: false } }), { reservationId: 'r1' })
    check('plan = global switch off', store.writes.some(w => w.data.cancelSmsPlan && w.data.cancelSmsPlan.reason === 'global switch off'), store.writes.map(w => w.data.cancelSmsPlan))
    check('未写 smsCancelAt', !store.writes.some(w => w.data.smsCancelAt !== undefined))
  }

  console.log('\nC5 未配置取消模板 → 不发不排')
  {
    const { store } = await run(s => base(s, { smsTemplates: {} }), { reservationId: 'r1' })
    check('plan = no cancel template', store.writes.some(w => w.data.cancelSmsPlan && w.data.cancelSmsPlan.reason === 'no cancel template'), store.writes.map(w => w.data.cancelSmsPlan))
  }

  console.log('\nC6 项目短信开关关闭 → 不发不排')
  {
    const { store } = await run(s => base(s, { smsEnabled: false }), { reservationId: 'r1' })
    check('plan = project sms off', store.writes.some(w => w.data.cancelSmsPlan && w.data.cancelSmsPlan.reason === 'project sms off'), store.writes.map(w => w.data.cancelSmsPlan))
  }

  console.log('\nC7 无手机号 → 不发不排')
  {
    const { store } = await run(s => base(s, { reservation: { phone: '' } }), { reservationId: 'r1' })
    check('plan = no phone', store.writes.some(w => w.data.cancelSmsPlan && w.data.cancelSmsPlan.reason === 'no phone'), store.writes.map(w => w.data.cancelSmsPlan))
  }

  console.log('\nC8 管理员代顾客取消 → 顾客仍收到取消订阅 + 管理员收到管理侧订阅')
  {
    const { store, res } = await run(s => {
      base(s, { openid: 'oAdmin' })
      s.cols.admins = { a1: { openid: 'oAdmin', role: 'owner' } }
    }, { reservationId: 'r1' })
    check('取消成功', res.code === 0, res)
    check('顾客（oCust）收到 reserveCancel', store.subscribeCalls.some(c => c.touser === 'oCust'), store.subscribeCalls.map(c => c.touser))
    check('管理员（oAdmin）收到 adminCancel', store.subscribeCalls.some(c => c.touser === 'oAdmin'), store.subscribeCalls.map(c => c.touser))
    check('两种模板各发一次', store.subscribeCalls.length === 2, store.subscribeCalls.length)
  }

  console.log('\nC9 非本人非管理员 → 无权取消')
  {
    const { store, res } = await run(s => { base(s, { openid: 'oStranger' }) }, { reservationId: 'r1' })
    check('返回失败', res.code !== 0, res)
    check('未改状态', (store.cols.reservations.r1 || {}).status === 'confirmed', store.cols.reservations.r1)
  }

  // 构造一个「按北京时间已经结束 minutesAgo 分钟」的场次（跨天自动回退）
  function endedAgo(mins) {
    const b = bjNow()
    let date = b.date, endMin = b.min - mins
    if (endMin < 0) { date = plusDays(b.date, -1); endMin += 1440 }
    return { date, sessionStart: hhmmFromMin(Math.max(0, endMin - 90)), sessionEnd: hhmmFromMin(endMin) }
  }
  // 构造一个「按北京时间还有 mins 分钟才结束」的场次（跨天自动前进）
  function endsIn(mins) {
    const b = bjNow()
    let date = b.date, endMin = b.min + mins
    if (endMin > 1439) { date = plusDays(b.date, 1); endMin -= 1440 }
    return { date, sessionStart: hhmmFromMin(Math.max(0, endMin - 90)), sessionEnd: hhmmFromMin(endMin) }
  }

  console.log('\nC10 【时区】场次按北京时间已结束 2 小时 → 拒绝取消（不得当成未结束）')
  {
    const s10 = endedAgo(120)
    const { store, res } = await run(s => base(s, { reservation: s10 }), { reservationId: 'r1' })
    check('返回失败（已过期不可取消）', res.code !== 0, res)
    check('状态未被改动', (store.cols.reservations.r1 || {}).status === 'confirmed', store.cols.reservations.r1)
    check('未发任何订阅消息', store.subscribeCalls.length === 0, store.subscribeCalls)
  }

  console.log('\nC11 【时区】场次按北京时间刚结束 1 分钟 → 拒绝取消（边界）')
  {
    const s11 = endedAgo(1)
    const { res } = await run(s => base(s, { reservation: s11 }), { reservationId: 'r1' })
    check('返回失败', res.code !== 0, res)
  }

  console.log('\nC12 【时区】场次按北京时间还要 1 小时才结束 → 允许取消（防过度矫偏）')
  {
    const s12 = endsIn(60)
    const { store, res } = await run(s => base(s, { reservation: s12 }), { reservationId: 'r1' })
    check('取消成功', res.code === 0, res)
    check('状态置 cancelled', (store.cols.reservations.r1 || {}).status === 'cancelled')
  }

  console.log('\nC13 缺 sessionEnd → 按当日 23:59 判定，未到则不误判过期')
  {
    const b = bjNow()
    // 当日无 sessionEnd；若当前北京时间已过 23:59 才应过期，否则应可取消
    const { res } = await run(s => base(s, { reservation: { date: b.date, sessionEnd: '' } }), { reservationId: 'r1' })
    const shouldExpire = b.min > 23 * 60 + 59
    check(`sessionEnd 缺省按 23:59（应过期=${shouldExpire}）`, shouldExpire ? res.code !== 0 : res.code === 0, res)
  }

  console.log('\nC14 场次结束于昨日 22:00 → 拒绝取消（跨天场景，旧实现会误放行）')
  {
    const b = bjNow()
    const { store, res } = await run(s => base(s, { reservation: { date: plusDays(b.date, -1), sessionStart: '20:00', sessionEnd: '22:00' } }), { reservationId: 'r1' })
    check('返回失败', res.code !== 0, res)
    check('状态未被改动', (store.cols.reservations.r1 || {}).status === 'confirmed', store.cols.reservations.r1)
  }

  console.log(`\n===== 结果：通过 ${state.pass} / 失败 ${state.fail} =====`)
  process.exit(state.fail ? 1 : 0)
})().catch(e => { console.error('测试脚本自身出错：', e); process.exit(2) })
