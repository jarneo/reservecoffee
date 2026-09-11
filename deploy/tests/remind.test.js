// deploy/tests/remind.test.js — remindReservation 离线集成测试
// 用法：/Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node deploy/tests/remind.test.js
const { runFunction, makeChecker, bjNow, plusDays, hhmmFromMin } = require('./harness')

const { check, state } = makeChecker()
const run = (setup) => runFunction('remindReservation', setup)

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
        smsnotify: { dayBefore: true, dayBeforeAt: AT, skipSmsIfWxOk: false, success: true, approaching: true, expired: true, cancel: true },
        subscribe: { dayBefore: true, reminder: true, reminderEnd: true },
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

  console.log(`\n===== 结果：通过 ${state.pass} / 失败 ${state.fail} =====`)
  process.exit(state.fail ? 1 : 0)
})().catch(e => { console.error('测试脚本自身出错：', e); process.exit(2) })
