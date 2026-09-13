// deploy/tests/remind.test.js — remindReservation 离线集成测试 + 通知计划（notifyPlan）单测
// 用法：/Users/mac/.workbuddy/binaries/node/versions/22.22.2-3/bin/node deploy/tests/remind.test.js
//
// 覆盖：
//   S1/S1b/S2/S2b/S3/S3b/S4/S4b/S4c  前一天提醒（去重、订阅记录闸、降级、错误落库、时刻可配）
//   S5/S6                            取消短信 / 成功短信延迟补发
//   S7–S11                           开场前提醒 + 结束提醒（含「ended 永不落库」回归）
//   S12                               notifyPlan 裁剪规则（纯函数矩阵）
//   S13                               notifyPlan 生效：不在计划内的类型两通道都不发
const { runFunction, loadLib, makeChecker, bjNow, plusDays, hhmmFromMin } = require('./harness')

const { check, state } = makeChecker()
const run = (setup) => runFunction('remindReservation', setup)
const lib = loadLib()

;(async () => {
  const bj = bjNow()
  const tomorrow = plusDays(bj.date, 1)
  const now = Date.now()
  // 把「配置时刻」设在 10 分钟前 → 当前时刻落在发送时间窗内（[at, at+180]）
  const AT = hhmmFromMin(bj.min - 10)

  // ---------- S1：前一天提醒 · 同一用户多笔只发最早一场 + 双通道 ----------
  console.log('\nS1 前一天提醒：去重取最早 + 微信/短信双通道')
  {
    const { store, res } = await run(s => {
      s.cols.config = {
        smsnotify: { dayBefore: true, dayBeforeAt: AT, skipSmsIfWxOk: false, success: true, cancel: true },
        subscribe: { dayBefore: true, reserveSuccess: true, reserveCancel: true },
        store: { name: '二曜路8号咖啡和清酒' }
      }
      s.smsTemplates = { dayBefore: '2729722', cancel: '2729679' }
      // 前一天模板真实字段键（MP 后台核对）：thing2 地点 / time1 入场时间 / thing3 入场时长 / thing4 温馨提醒
      s.wx.allowedKeys = ['thing2', 'time1', 'thing3', 'thing4']
      s.cols.projects = { p1: { _id: 'p1', name: '法兰绒深烘咖啡', smsEnabled: true } }
      s.cols.reservations = {
        a1: { _id: 'a1', openid: 'oA', projectId: 'p1', date: tomorrow, sessionStart: '14:00', sessionEnd: '15:30', phone: '13800000001', status: 'confirmed', createdAt: 2 },
        a2: { _id: 'a2', openid: 'oA', projectId: 'p1', date: tomorrow, sessionStart: '09:00', sessionEnd: '10:30', phone: '13800000001', status: 'confirmed', createdAt: 1 },
        b1: { _id: 'b1', openid: 'oB', projectId: 'p1', date: tomorrow, sessionStart: '11:00', sessionEnd: '12:30', phone: '13800000002', status: 'confirmed', createdAt: 3 }
      }
    })
    check('两个用户各发一条（sentDayBefore=2）', res.data.sentDayBefore === 2, res.data)
    check('微信只调用 2 次', store.subscribeCalls.length === 2, store.subscribeCalls.length)
    check('oA 收到的是最早一场 09:00', store.subscribeCalls.some(c => c.touser === 'oA' && c.data.time1.value.endsWith('09:00')), store.subscribeCalls.map(c => c.data.time1.value))
    check('字段键 = thing2/time1/thing3/thing4', store.subscribeCalls.every(c => ['thing2', 'time1', 'thing3', 'thing4'].every(k => c.data[k])), store.subscribeCalls.map(c => Object.keys(c.data)))
    check('地点=店铺名', store.subscribeCalls.every(c => c.data.thing2.value === '二曜路8号咖啡和清酒'))
    check('时长字段 = 结束-开始（90分钟）', store.subscribeCalls.every(c => c.data.thing3.value === '90分钟'), store.subscribeCalls.map(c => c.data.thing3.value))
    check('温馨提醒文案正确', store.subscribeCalls.every(c => c.data.thing4.value === '明天有预约哦，别忘记了。'))
    check('短信两条（sentDayBeforeSms=2）', res.data.sentDayBeforeSms === 2 && store.smsCalls.length === 2, res.data)
    check('短信用的 dayBefore 模板 2729722', store.smsCalls.every(c => c.templateId === '2729722'), store.smsCalls)
    check('三笔全部打上 dayBeforeNotified', store.writes.filter(w => w.data.dayBeforeNotified).length === 3, store.writes.length)
    check('被跳过的 14:00 标记 dup-openid', store.writes.some(w => w.id === 'a1' && w.data.dayBeforeSkipped === 'dup-openid'))
    check('结果落库 dayBeforeNotify.ok', store.writes.some(w => w.data.dayBeforeNotify && w.data.dayBeforeNotify.ok === true))
  }

  // ---------- S1b：用户订阅记录闸（users.subscriptions.dayBefore=false → 不发微信，短信照旧） ----------
  console.log('\nS1b 统一订阅记录：用户关掉「前一天提醒」则不发微信，短信照旧兜底')
  {
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { dayBefore: true, dayBeforeAt: AT, skipSmsIfWxOk: false }, subscribe: { dayBefore: true }, store: {} }
      s.smsTemplates = { dayBefore: '2729722' }
      s.wx.allowedKeys = ['thing2', 'time1', 'thing3', 'thing4']
      s.cols.projects = { p1: { name: '清酒品鉴', smsEnabled: true } }
      s.cols.users = { oA: { subscriptions: { dayBefore: false } } }
      s.cols.reservations = { a1: { _id: 'a1', openid: 'oA', projectId: 'p1', date: tomorrow, sessionStart: '09:00', sessionEnd: '10:30', phone: '13800000001', status: 'confirmed', createdAt: 1 } }
    })
    check('微信 0 次（用户已关闭该通知）', store.subscribeCalls.length === 0, store.subscribeCalls.length)
    check('短信仍发出 1 条（短信不受订阅记录影响）', store.smsCalls.length === 1 && res.data.sentDayBeforeSms === 1, { sms: store.smsCalls.length, res: res.data })
    check('sentDayBefore=1（本轮已处理）', res.data.sentDayBefore === 1, res.data)
  }

  // ---------- S2：微信优先降级（微信已送达 → 不发短信） ----------
  console.log('\nS2 微信优先降级开关：微信送达则不补发短信')
  {
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { dayBefore: true, dayBeforeAt: AT, skipSmsIfWxOk: true }, subscribe: { dayBefore: true }, store: {} }
      s.smsTemplates = { dayBefore: '2729722' }
      s.wx.allowedKeys = ['thing2', 'time1', 'thing3', 'thing4']
      s.cols.projects = { p1: { name: '清酒品鉴', smsEnabled: true } }
      s.cols.reservations = { a1: { _id: 'a1', openid: 'oA', projectId: 'p1', date: tomorrow, sessionStart: '09:00', sessionEnd: '10:30', phone: '13800000001', status: 'confirmed', createdAt: 1 } }
    })
    check('微信发出', store.subscribeCalls.length === 1)
    check('短信 0 条', store.smsCalls.length === 0 && res.data.sentDayBeforeSms === 0, store.smsCalls)
    check('短信被标记 skipped/wx delivered', store.writes.some(w => w.data.dayBeforeSms && w.data.dayBeforeSms.skipped === true))
  }

  // ---------- S2b：开关关闭 → 双通道都发 ----------
  console.log('\nS2b 降级开关关闭：微信与短信都发')
  {
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { dayBefore: true, dayBeforeAt: AT, skipSmsIfWxOk: false }, subscribe: { dayBefore: true }, store: {} }
      s.smsTemplates = { dayBefore: '2729722' }
      s.wx.allowedKeys = ['thing2', 'time1', 'thing3', 'thing4']
      s.cols.projects = { p1: { name: '清酒品鉴', smsEnabled: true } }
      s.cols.reservations = { a1: { _id: 'a1', openid: 'oA', projectId: 'p1', date: tomorrow, sessionStart: '09:00', sessionEnd: '10:30', phone: '13800000001', status: 'confirmed', createdAt: 1 } }
    })
    check('微信 1 次 + 短信 1 条', store.subscribeCalls.length === 1 && store.smsCalls.length === 1, { wx: store.subscribeCalls.length, sms: store.smsCalls.length })
    check('sentDayBeforeSms=1', res.data.sentDayBeforeSms === 1, res.data)
  }

  // ---------- S3：字段键错（47003）→ 只发 1 次且错误落库可见（不掩盖） ----------
  console.log('\nS3 47003 字段键错：只调 1 次、错误落库（不重试、不静默）')
  {
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { dayBefore: true, dayBeforeAt: AT, skipSmsIfWxOk: false }, subscribe: { dayBefore: true }, store: {} }
      s.smsTemplates = { dayBefore: '2729722' }
      s.wx.allowedKeys = ['thing1', 'time2', 'thing3', 'const4'] // 故意不认真实键 → 模拟后台改模板/键名写错
      s.cols.projects = { p1: { name: '法兰绒研习社', smsEnabled: true } }
      s.cols.reservations = { a1: { _id: 'a1', openid: 'oA', projectId: 'p1', date: tomorrow, sessionStart: '09:00', sessionEnd: '10:30', phone: '13800000001', status: 'confirmed', createdAt: 1 } }
    })
    check('只调用 1 次微信（不再换组试错）', store.subscribeCalls.length === 1, store.subscribeCalls.length)
    check('落库 errCode=47003 供排查', store.writes.some(w => w.data.dayBeforeNotify && w.data.dayBeforeNotify.errCode === 47003), store.writes.map(w => w.data.dayBeforeNotify))
    check('微信失败 → 短信兜底发出', store.smsCalls.length === 1, store.smsCalls)
  }

  // ---------- S3b：未授权（43101）→ 短信兜底、错误落库 ----------
  console.log('\nS3b 43101 未授权：短信兜底 + 错误落库')
  {
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { dayBefore: true, dayBeforeAt: AT, skipSmsIfWxOk: false }, subscribe: { dayBefore: true }, store: {} }
      s.smsTemplates = { dayBefore: '2729722' }
      s.wx.errCode = 43101
      s.cols.projects = { p1: { name: '清酒品鉴', smsEnabled: true } }
      s.cols.reservations = { a1: { _id: 'a1', openid: 'oA', projectId: 'p1', date: tomorrow, sessionStart: '09:00', sessionEnd: '10:30', phone: '13800000001', status: 'confirmed', createdAt: 1 } }
    })
    check('只调用 1 次微信', store.subscribeCalls.length === 1, store.subscribeCalls.length)
    check('微信失败 → 短信兜底发出', store.smsCalls.length === 1, store.smsCalls)
    check('落库 errCode=43101 供排查', store.writes.some(w => w.data.dayBeforeNotify && w.data.dayBeforeNotify.errCode === 43101), store.writes.map(w => w.data.dayBeforeNotify))
  }

  // ---------- S4：未到发送时刻 → 不发送 ----------
  console.log('\nS4 未到设定时刻（' + bj.hhmm + '）不发送')
  {
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { dayBefore: true, dayBeforeAt: '23:59' }, subscribe: { dayBefore: true }, store: {} }
      s.smsTemplates = { dayBefore: '2729722' }
      s.cols.projects = { p1: { name: 'x', smsEnabled: true } }
      s.cols.reservations = { a1: { _id: 'a1', openid: 'oA', projectId: 'p1', date: tomorrow, sessionStart: '09:00', sessionEnd: '10:30', phone: '13800000001', status: 'confirmed' } }
    })
    if (bj.min >= 1439) console.log('  - 跳过（当前已过 23:59）')
    else {
      check('微信 0 次', store.subscribeCalls.length === 0)
      check('未打标 dayBeforeNotified', store.writes.filter(w => w.data.dayBeforeNotified).length === 0)
      check('sentDayBefore=0', res.data.sentDayBefore === 0, res.data)
    }
  }

  // ---------- S4b：超过发送时间窗（默认 180 分钟）→ 不再补发，避免深夜打扰 ----------
  console.log('\nS4b 超过发送时间窗上限不发送（防深夜补发）')
  {
    const early = hhmmFromMin(Math.max(0, bj.min - 400)) // 时刻设在 400 分钟前，远超 180 分钟窗
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { dayBefore: true, dayBeforeAt: early, dayBeforeWindow: 180 }, subscribe: { dayBefore: true }, store: {} }
      s.smsTemplates = { dayBefore: '2729722' }
      s.cols.projects = { p1: { name: 'x', smsEnabled: true } }
      s.cols.reservations = { a1: { _id: 'a1', openid: 'oA', projectId: 'p1', date: tomorrow, sessionStart: '09:00', sessionEnd: '10:30', phone: '13800000001', status: 'confirmed' } }
    })
    if (bj.min < 400) console.log('  - 跳过（当前时刻太早，无法构造 400 分钟窗）')
    else {
      check('微信 0 次', store.subscribeCalls.length === 0, store.subscribeCalls.length)
      check('未打标 dayBeforeNotified', store.writes.filter(w => w.data.dayBeforeNotified).length === 0)
      check('sentDayBefore=0', res.data.sentDayBefore === 0, res.data)
    }
  }

  // ---------- S4c：可配置任意时刻（6 点 / 3 点等）均生效 ----------
  console.log('\nS4c 前一天提醒时刻可配置为任意 HH:mm（非 16–20 点区间也生效）')
  {
    const earlyHH = hhmmFromMin(bj.min - 6)
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { dayBefore: true, dayBeforeAt: earlyHH }, subscribe: { dayBefore: true }, store: {} }
      s.smsTemplates = { dayBefore: '2729722' }
      s.wx.allowedKeys = ['thing2', 'time1', 'thing3', 'thing4']
      s.cols.projects = { p1: { name: 'x', smsEnabled: true } }
      s.cols.reservations = { a1: { _id: 'a1', openid: 'oA', projectId: 'p1', date: tomorrow, sessionStart: '09:00', sessionEnd: '10:30', phone: '13800000001', status: 'confirmed' } }
    })
    check('任意时刻配置可触发（微信 1 次）', store.subscribeCalls.length === 1, { at: earlyHH, calls: store.subscribeCalls.length })
    check('sentDayBefore=1', res.data.sentDayBefore === 1, res.data)
  }

  // ---------- S5：取消短信延迟补发 + 状态复校 ----------
  console.log('\nS5 取消短信：延迟到点补发，发送前复校仍为 cancelled')
  {
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { cancel: true, cancelDelay: 3 }, subscribe: {}, store: {} }
      s.smsTemplates = { cancel: '2729679' }
      s.cols.projects = { p1: { name: '法兰绒深烘咖啡', smsEnabled: true } }
      s.cols.reservations = {
        c1: { _id: 'c1', openid: 'oA', projectId: 'p1', phone: '13800000001', status: 'cancelled', smsCancelSent: false, smsCancelAt: now - 1000 },
        c2: { _id: 'c2', openid: 'oB', projectId: 'p1', phone: '13800000002', status: 'confirmed', smsCancelSent: false, smsCancelAt: now - 1000 },
        c3: { _id: 'c3', openid: 'oC', projectId: 'p1', phone: '13800000003', status: 'cancelled', smsCancelSent: false, smsCancelAt: now + 600000 }
      }
    })
    check('只发 1 条取消短信（sentCancel=1）', res.data.sentCancel === 1 && store.smsCalls.length === 1, res.data)
    check('用取消模板 2729679', store.smsCalls[0] && store.smsCalls[0].templateId === '2729679', store.smsCalls)
    check('仍为 confirmed 的 c2 被跳过', store.writes.some(w => w.id === 'c2' && w.data.smsCancelResult && w.data.smsCancelResult.reason === 'no longer cancelled'))
    check('未到延迟时刻的 c3 不处理', !store.writes.some(w => w.id === 'c3'))
    check('已处理两笔打标 smsCancelSent', store.writes.filter(w => w.data.smsCancelSent === true).length === 2)
  }

  // ---------- S6：成功短信延迟补发 + 降级 ----------
  console.log('\nS6 成功短信延迟补发：wxSuccessOk + skipSmsIfWxOk 生效')
  {
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { success: true, skipSmsIfWxOk: true }, subscribe: {}, store: {} }
      s.smsTemplates = { success: '2715328' }
      s.cols.projects = { p1: { name: '法兰绒深烘咖啡', smsEnabled: true } }
      s.cols.reservations = {
        s1: { _id: 's1', openid: 'oA', projectId: 'p1', phone: '13800000001', status: 'confirmed', smsSuccessSent: false, smsSuccessAt: now - 1000, wxSuccessOk: true },
        s2: { _id: 's2', openid: 'oB', projectId: 'p1', phone: '13800000002', status: 'confirmed', smsSuccessSent: false, smsSuccessAt: now - 1000, wxSuccessOk: false }
      }
    })
    check('仅 s2 真发短信（微信未送达才兜底）', store.smsCalls.length === 1 && store.smsCalls[0].phone === '13800000002', store.smsCalls)
    check('s1 标记 skipped', store.writes.some(w => w.id === 's1' && w.data.smsResult && w.data.smsResult.skipped === true))
    check('sentSuccess=1', res.data.sentSuccess === 1, res.data)
  }

  // ---------- S7：临近提醒 + 降级 ----------
  console.log('\nS7 临近提醒：微信 ok 时不发临近短信，并落库 reminderNotify')
  {
    const t = new Date(Date.now() - 10 * 60000 + 8 * 3600 * 1000)
    const d = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
    const hh = String(t.getUTCHours()).padStart(2, '0')
    const mm = String(t.getUTCMinutes()).padStart(2, '0')
    const { store, res } = await run(s => {
      s.cols.config = { smsnotify: { approaching: true, approachingWhen: 'before', approachingOffset: 30, skipSmsIfWxOk: true }, subscribe: { reminder: true }, store: {} }
      s.smsTemplates = { approaching: '2716156' }
      s.cols.projects = { p1: { name: '法兰绒深烘咖啡', smsEnabled: true } }
      s.cols.reservations = { a1: { _id: 'a1', openid: 'oA', projectId: 'p1', date: d, sessionStart: hh + ':' + mm, sessionEnd: '23:59', phone: '13800000001', status: 'confirmed' } }
    })
    if (bj.min >= 23 * 60 + 50) console.log('  - 跳过（临近午夜，场次结束时间会干扰判定）')
    else {
      check('微信临近提醒发出（1 次）', store.subscribeCalls.length === 1, store.subscribeCalls.length)
      check('短信 0 条（微信优先）', store.smsCalls.length === 0, store.smsCalls)
      check('打标 reminded + 落库 reminderNotify.ok', store.writes.some(w => w.id === 'a1' && w.data.reminded === true && w.data.reminderNotify && w.data.reminderNotify.ok === true))
      check('sentStart=1', res.data.sentStart === 1, res.data)
    }
  }

  // ---------- S8/S9/S10/S11：pass ④ 临近/结束提醒（回归「ended 永不落库」） ----------
  // 北京读数的日期 + 'HH:mm'（offsetMin 为相对当前时刻的分钟偏移）
  const bjAt = (offsetMin) => {
    const t = new Date(Date.now() + 8 * 3600 * 1000 + offsetMin * 60000)
    const p = n => String(n).padStart(2, '0')
    return {
      date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
      hm: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
    }
  }
  const baseEnd = (s, r, over = {}) => {
    s.cols.config = { smsnotify: Object.assign({ approaching: true, expired: true, expiredWhen: 'after', expiredOffset: 5, skipSmsIfWxOk: false }, over.smsnotify || {}), subscribe: { reminderEnd: true, reminder: true }, store: {} }
    s.smsTemplates = { expired: '2716682', approaching: '2716156' }
    s.wx.allowedKeys = ['thing10', 'time12', 'time14', 'thing9']
    s.cols.projects = { p1: { name: '法兰绒深烘咖啡', smsEnabled: true } }
    s.cols.reservations = { a1: Object.assign({ _id: 'a1', openid: 'oA', projectId: 'p1', phone: '13800000001', status: 'confirmed' }, r) }
  }

  console.log('\nS8 已发过开场前提醒的预约，结束后必须打 ended（回归：where 曾带 reminded:_.neq(true) 导致永不结束）')
  {
    const yday = plusDays(bj.date, -1)
    const { store, res } = await run(s => baseEnd(s, { date: yday, sessionStart: '20:00', sessionEnd: '21:00', reminded: true }))
    const r1 = store.cols.reservations.a1
    check('checked=1（能查到，不再被 reminded 过滤掉）', res.data.checked === 1, res.data)
    check('已打 ended=true', r1.ended === true, r1)
    check('sentEnd=1', res.data.sentEnd === 1, res.data)
    check('超出发送时间窗 → 记 reminderEndSkipped=too-late', r1.reminderEndSkipped === 'too-late', r1)
    check('超窗不补发微信', store.subscribeCalls.length === 0, store.subscribeCalls.length)
    check('超窗不补发短信（不深夜打扰）', store.smsCalls.length === 0, store.smsCalls.length)
  }

  console.log('\nS9 场次刚结束（窗口内）：打 ended + 发结束提醒微信 + 过期短信')
  {
    const end = bjAt(-30)
    const start = bjAt(-120)
    const { store, res } = await run(s => baseEnd(s, { date: end.date, sessionStart: start.hm, sessionEnd: end.hm, reminded: true }))
    const r1 = store.cols.reservations.a1
    check('已打 ended=true', r1.ended === true, r1)
    check('未记 too-late', r1.reminderEndSkipped === undefined, r1)
    check('微信结束提醒发出（1 次）', store.subscribeCalls.length === 1, store.subscribeCalls.length)
    check('模板为 reminderEnd', store.subscribeCalls[0] && store.subscribeCalls[0].templateId === 'ShNSAxZvFsDgyZhFfi3OTUoYqm5khLVJkhCnqI1IEeo', store.subscribeCalls[0])
    check('结束提醒字段键 thing10/time12/time14/thing9', store.subscribeCalls[0] && ['thing10', 'time12', 'time14', 'thing9'].every(k => store.subscribeCalls[0].data[k]), store.subscribeCalls[0] && Object.keys(store.subscribeCalls[0].data))
    check('过期短信发出（1 条）', store.smsCalls.length === 1, store.smsCalls)
    check('落库 reminderEndNotify', r1.reminderEndNotify && r1.reminderEndNotify.ok === true, r1.reminderEndNotify)
    check('sentEnd=1 / sentStart=0（不重复发临近提醒）', res.data.sentEnd === 1 && res.data.sentStart === 0, res.data)
  }

  console.log('\nS10 已 reminded 但场次尚未结束 → 不重复发送临近提醒，也不误打 ended')
  {
    const start = bjAt(30)          // 30 分钟后开始（临近提醒触发点已到：默认开始前 60 分钟）
    const end = bjAt(120)
    const { store, res } = await run(s => baseEnd(s, { date: start.date, sessionStart: start.hm, sessionEnd: end.hm, reminded: true }))
    const r1 = store.cols.reservations.a1
    check('不重发临近提醒微信', store.subscribeCalls.length === 0, store.subscribeCalls.length)
    check('不重发临近短信', store.smsCalls.length === 0, store.smsCalls.length)
    check('未打 ended', r1.ended === undefined, r1)
    check('未重写 reminded', !store.writes.some(w => w.data && 'reminded' in w.data), store.writes)
    check('sentStart=0 / sentEnd=0', res.data.sentStart === 0 && res.data.sentEnd === 0, res.data)
  }

  console.log('\nS11 expiredWhen 缺省应为「结束后」：结束前 3 分钟不得提前触发结束提醒')
  {
    const end = bjAt(3)             // 3 分钟后结束：旧默认(before/5min)会在 now-2min 就触发，新默认(after/5min)要等到 +8min
    const start = bjAt(-87)
    const { store, res } = await run(s => {
      baseEnd(s, { date: end.date, sessionStart: start.hm, sessionEnd: end.hm, reminded: true },
        { smsnotify: { expiredWhen: undefined, expiredOffset: undefined } })
    })
    const r1 = store.cols.reservations.a1
    check('未提前触发结束提醒（ended 未打）', r1.ended === undefined, r1)
    check('未发微信/短信', store.subscribeCalls.length === 0 && store.smsCalls.length === 0, { w: store.subscribeCalls.length, s: store.smsCalls.length })
  }

  // ---------- S12：notifyPlan 规则（纯函数矩阵，返回完整未来适用集合、不硬截断） ----------
  // 规则：确认恒开；前一天要求「现在仍早于 D-1 dayBeforeAt + 180min」；
  //       开场前/结束要求触发时刻在未来；**不再按 ≤3 截断**（远期单可返回 4 条）。
  //       （提交弹窗的 ≤3 分配由前端 tmplIdsOfPlan 另行负责，此处只验证计划本身完整。）
  console.log('\nS12 notifyPlan：返回完整未来适用集合（远期单最多 4 条，不再硬截断到 3）')
  {
    const cfg = lib.notifyWindowCfg({})   // dayBeforeAt 17:30 / window 180 / before 60 / after 5
    const count = p => ['reserveSuccess', 'dayBefore', 'reminder', 'reminderEnd'].filter(k => p[k]).length

    // 场景 E：一周后预约（09-20），提交于 09-13 10:00 → 三项时间轴都在未来 → 完整 4 条
    const pE = lib.notifyPlan({ date: '2026-09-20', sessionStart: '14:00', sessionEnd: '15:30' }, cfg, lib.bjTs('2026-09-13', '10:00'))
    check('E 一周后：前一天✓ 开场前✓ 结束✓（完整，不截断）→ 4 条', pE.dayBefore === true && pE.reminder === true && pE.reminderEnd === true && count(pE) === 4, pE)

    // 场景 B：当天 3 小时后（09-13 13:00 场），提交于 09-13 10:00
    const pB = lib.notifyPlan({ date: '2026-09-13', sessionStart: '13:00', sessionEnd: '14:30' }, cfg, lib.bjTs('2026-09-13', '10:00'))
    check('B 当天稍晚：前一天✗(过窗) 开场前✓ 结束✓ → 3 条', pB.dayBefore === false && pB.reminder === true && pB.reminderEnd === true && count(pB) === 3, pB)

    // 场景 A：30 分钟后开场（09-13 10:30），提交于 09-13 10:00
    const pA = lib.notifyPlan({ date: '2026-09-13', sessionStart: '10:30', sessionEnd: '12:00' }, cfg, lib.bjTs('2026-09-13', '10:00'))
    check('A 极紧急：开场前✗(触发点已过) → 2 条', pA.reminder === false && pA.reminderEnd === true && count(pA) === 2, pA)

    // 场景 C：次日、但已过当天 20:30 窗口（提交于 09-13 21:00）
    const pC = lib.notifyPlan({ date: '2026-09-14', sessionStart: '14:00', sessionEnd: '15:30' }, cfg, lib.bjTs('2026-09-13', '21:00'))
    check('C 次日但过窗：前一天✗ 开场前✓ 结束✓ → 3 条', pC.dayBefore === false && pC.reminder === true && pC.reminderEnd === true && count(pC) === 3, pC)

    // notifyPlan 返回的完整计划最多 4 条（确认 + 3 个时间轴）；≤3 约束只作用于提交弹窗（前端 tmplIdsOfPlan）
    const within = [pA, pB, pC, pE].every(p => count(p) <= 4)
    check('所有场景计划均 ≤4 条（提交弹窗另行裁剪为 ≤3）', within === true)

    // dayBeforeAt 可配：同一时刻（前一天 21:00）提交次日预约，
    // 默认 17:30（窗口 17:30–20:30）已过 → 拿不到；改成 22:00（窗口 22:00–次日 01:00）则可拿到。
    const cfg22 = lib.notifyWindowCfg({ dayBeforeAt: '22:00' })
    const nowC = lib.bjTs('2026-09-13', '21:00')
    const pDefault = lib.notifyPlan({ date: '2026-09-14', sessionStart: '14:00', sessionEnd: '15:30' }, cfg, nowC)
    const p22 = lib.notifyPlan({ date: '2026-09-14', sessionStart: '14:00', sessionEnd: '15:30' }, cfg22, nowC)
    check('dayBeforeAt=17:30 时已过窗（前一天✗）', pDefault.dayBefore === false, pDefault)
    check('dayBeforeAt=22:00 时窗口顺延（前一天✓）', p22.dayBefore === true, p22)
  }

  // ---------- S13：notifyPlan 生效 —— 显式排除的类型两通道都不发 ----------
  console.log('\nS13 不在 notifyPlan 内的提醒：微信与短信都不发（历史/边缘预约可显式排除某类）')
  {
    // 13a：结束提醒未被裁剪进计划 → 结束后不发（微信 0 / 短信 0），仍打 ended
    const end = bjAt(-30)
    const start = bjAt(-120)
    const { store: st1, res: rs1 } = await run(s => baseEnd(s, {
      date: end.date, sessionStart: start.hm, sessionEnd: end.hm, reminded: true,
      notifyPlan: { reserveSuccess: true, dayBefore: false, reminder: true, reminderEnd: false }
    }))
    const a1 = st1.cols.reservations.a1
    check('13a 结束提醒不在计划 → 微信 0 次', st1.subscribeCalls.length === 0, st1.subscribeCalls.length)
    check('13a 结束提醒不在计划 → 短信 0 条', st1.smsCalls.length === 0, st1.smsCalls)
    check('13a 仍打 ended 且记 not-in-plan', a1.ended === true && a1.reminderEndSkipped === 'not-in-plan', a1)
    check('13a sentEnd=1', rs1.data.sentEnd === 1, rs1.data)

    // 13b：开场前提醒未被裁剪进计划 → 到达触发点也不发，但仍打 reminded 防重试
    const start2 = bjAt(30)
    const end2 = bjAt(120)
    const { store: st2, res: rs2 } = await run(s => baseEnd(s, {
      date: start2.date, sessionStart: start2.hm, sessionEnd: end2.hm,
      notifyPlan: { reserveSuccess: true, dayBefore: false, reminder: false, reminderEnd: true }
    }))
    const b1 = st2.cols.reservations.a1
    check('13b 开场前不在计划 → 微信 0 次', st2.subscribeCalls.length === 0, st2.subscribeCalls.length)
    check('13b 开场前不在计划 → 短信 0 条', st2.smsCalls.length === 0, st2.smsCalls)
    check('13b 仍打 reminded 且记 not-in-plan', b1.reminded === true && b1.reminderSkipped === 'not-in-plan', b1)
    check('13b sentStart=1', rs2.data.sentStart === 1, rs2.data)

    // 13c：历史预约（无 notifyPlan）→ 保持旧行为，不误拦
    const { store: st3 } = await run(s => baseEnd(s, { date: end.date, sessionStart: start.hm, sessionEnd: end.hm, reminded: true }))
    check('13c 无 notifyPlan 的历史预约仍按旧行为发送', st3.subscribeCalls.length === 1 && st3.smsCalls.length === 1, { w: st3.subscribeCalls.length, s: st3.smsCalls.length })
  }

  console.log(`\n===== 结果：通过 ${state.pass} / 失败 ${state.fail} =====`)
  process.exit(state.fail ? 1 : 0)
})().catch(e => { console.error('测试脚本自身出错：', e); process.exit(2) })
