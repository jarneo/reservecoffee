// deploy/tests/review.test.js — 审核（单条 + 批量）离线测试
// 重点锁住两条契约：
//   ① 审核 **通过 / 拒绝 都不再给管理员推订阅消息**（2026-09-12 需求）；
//      其中「通过」仍给顾客推「预约成功」，「拒绝」不给顾客发任何消息。
//   ② 批量审核（reviewAllReservations）与单条（reviewReservation）行为必须一致——两文件互为拷贝，最易不同步。
// 用法：/Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node deploy/tests/review.test.js
const { runFunction, makeChecker } = require('./harness')

const { check, state } = makeChecker()

// 模板 ID（与 cloudfunctions/_lib/index.js TPL 一致）
const TPL_SUCCESS = 'ShNSAxZvFsDgyZhFfi3OTbofXCzjsM5P1-sSD8ZU2e4'   // 预约成功（顾客）
const TPL_ADMIN_REVIEW = 'UQJ5AfBWVUTQO-upC-3_W-UeDu_BgPPGoyj11Ei5Py8' // 待审核提醒（管理员）

const REASON = 'admin push disabled on review'

const runOne = (setup, event) => runFunction('reviewReservation', setup, { event })
const runAll = (setup, event) => runFunction('reviewAllReservations', setup, { event })

const RES = (id, over = {}) => Object.assign({
  _id: id, openid: 'oCust', projectId: 'p1', sessionId: 's1', scheduleId: 'sch1',
  date: '2099-01-01', sessionStart: '10:00', sessionEnd: '11:30', partySize: 2,
  name: '张三', phone: '13800000001', status: 'pending', review: 'pending', createdAt: 1000
}, over)

function base(s, over = {}) {
  s.openid = over.openid || 'oAdmin'
  s.cols.admins = { a1: { openid: 'oAdmin', role: 'owner' } }
  // smsEnabled=false：隔离短信分支，只看订阅消息行为
  s.cols.projects = { p1: { _id: 'p1', name: '法兰绒深烘咖啡', smsEnabled: false } }
  s.cols.reservations = over.reservations || { r1: RES('r1') }
  s.cols.users = {}
  s.cols.schedules = { sch1: { _id: 'sch1', sessions: [{ id: 's1', capacity: 4, booked: 2 }] } }
}

// 计数辅助：按模板统计订阅调用
const callsOf = (store, tpl) => store.subscribeCalls.filter(c => c.templateId === tpl)
const adminCalls = (store) => callsOf(store, TPL_ADMIN_REVIEW)
const tomb = (store, id) => ((store.cols.reservations[id] || {}).adminNotifyReview || {})

;(async () => {
  console.log('\nV1 单条·审核通过 → 顾客收「预约成功」，管理员**不再**收到订阅')
  {
    const { store, res } = await runOne(s => base(s), { reservationId: 'r1', decision: 'approve' })
    check('审核成功', res.code === 0, res)
    check('状态置 approved/confirmed', (store.cols.reservations.r1 || {}).review === 'approved' && (store.cols.reservations.r1 || {}).status === 'confirmed', store.cols.reservations.r1)
    check('顾客收到 1 条预约成功', callsOf(store, TPL_SUCCESS).length === 1, store.subscribeCalls.map(c => c.templateId))
    check('管理员 0 条（已移除通过推送）', adminCalls(store).length === 0, store.subscribeCalls.map(c => c.touser))
    check('落库 skipped 原因（可排查）', tomb(store, 'r1').skipped === true && tomb(store, 'r1').reason === REASON, tomb(store, 'r1'))
    check('落库 decision=approve', tomb(store, 'r1').decision === 'approve', tomb(store, 'r1'))
  }

  console.log('\nV2 单条·审核拒绝 → 管理员**也不推**；顾客不发「预约成功」')
  {
    const { store, res } = await runOne(s => base(s), { reservationId: 'r1', decision: 'reject' })
    check('审核成功', res.code === 0, res)
    check('状态置 rejected/cancelled', (store.cols.reservations.r1 || {}).review === 'rejected' && (store.cols.reservations.r1 || {}).status === 'cancelled', store.cols.reservations.r1)
    check('管理员 0 条（拒绝也停推）', adminCalls(store).length === 0, store.subscribeCalls.map(c => c.templateId))
    check('顾客未收到预约成功', callsOf(store, TPL_SUCCESS).length === 0, store.subscribeCalls.map(c => c.templateId))
    check('名额已释放（booked 2→0）', (store.cols.schedules.sch1 || {}).sessions[0].booked === 0, (store.cols.schedules.sch1 || {}).sessions)
    check('落库 skipped 原因 + decision=reject', tomb(store, 'r1').skipped === true && tomb(store, 'r1').reason === REASON && tomb(store, 'r1').decision === 'reject', tomb(store, 'r1'))
  }

  console.log('\nV3 批量·全部通过 → 顾客逐条收到，管理员 0 条（与单条一致）')
  {
    const { store, res } = await runAll(s => base(s, {
      reservations: { r1: RES('r1'), r2: RES('r2', { openid: 'oCust2', createdAt: 2000 }) }
    }), { decision: 'approve' })
    check('审核成功', res.code === 0, res)
    check('通过 2 条', (res.data || {}).approved === 2, res.data)
    check('顾客收到 2 条预约成功', callsOf(store, TPL_SUCCESS).length === 2, callsOf(store, TPL_SUCCESS).length)
    check('管理员 0 条', adminCalls(store).length === 0, adminCalls(store))
    check('两条都落 skipped 原因', tomb(store, 'r1').skipped === true && tomb(store, 'r2').skipped === true)
  }

  console.log('\nV4 批量·全部拒绝 → 管理员 0 条（与单条一致）')
  {
    const { store, res } = await runAll(s => base(s, {
      reservations: { r1: RES('r1'), r2: RES('r2', { openid: 'oCust2', createdAt: 2000 }) }
    }), { decision: 'reject' })
    check('审核成功', res.code === 0, res)
    check('拒绝 2 条', (res.data || {}).approved === 2, res.data)
    check('管理员 0 条', adminCalls(store).length === 0, adminCalls(store).length)
    check('顾客 0 条预约成功', callsOf(store, TPL_SUCCESS).length === 0)
    check('两条都落 skipped 原因 + decision=reject', tomb(store, 'r1').decision === 'reject' && tomb(store, 'r2').decision === 'reject', [tomb(store, 'r1'), tomb(store, 'r2')])
  }

  console.log('\nV5 非管理员 → 两个入口都拒绝（权限不被绕过）')
  {
    const a = await runOne(s => base(s, { openid: 'oStranger' }), { reservationId: 'r1', decision: 'approve' })
    const b = await runAll(s => base(s, { openid: 'oStranger' }), { decision: 'approve' })
    check('reviewReservation 拒绝', a.res.code !== 0, a.res)
    check('reviewAllReservations 拒绝', b.res.code !== 0, b.res)
    check('无任何订阅发出', a.store.subscribeCalls.length === 0 && b.store.subscribeCalls.length === 0)
  }

  console.log('\nV6 已处理过的预约（review!=pending）→ 不重复处理')
  {
    const { res } = await runOne(s => base(s, { reservations: { r1: RES('r1', { review: 'approved', status: 'confirmed' }) } }), { reservationId: 'r1', decision: 'approve' })
    check('返回失败', res.code !== 0, res)
  }

  console.log(`\n===== 结果：通过 ${state.pass} / 失败 ${state.fail} =====`)
  process.exit(state.fail ? 1 : 0)
})().catch(e => { console.error('测试脚本自身出错：', e); process.exit(2) })
