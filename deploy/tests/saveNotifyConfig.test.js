// deploy/tests/saveNotifyConfig.test.js — saveNotifyConfig 离线集成测试
// 重点守两条：
//   ① config 集合里目标文档【不存在】时必须能正常新建（曾因 set 的 data 带 _id 而每次保存都失败，
//      云端报 `document.set:fail -501007 不能更新_id的值`，客户端只看到笼统的 -504002）；
//   ② 已存在时走 update，只覆盖传入字段，不能把别的字段抹掉。
// 用法：/Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node deploy/tests/saveNotifyConfig.test.js
const { runFunction, makeChecker } = require('./harness')

const { check, state } = makeChecker()
const run = (setup, event) => runFunction('saveNotifyConfig', setup, { event })

// owner 身份 + 一块「什么都没有」的 config 集合（复刻线上：smsnotify 存在，subscribe 不存在）
function base(s, over = {}) {
  s.openid = over.openid || 'oOwner'
  s.cols.admins = { a1: { _id: 'a1', openid: over.openid || 'oOwner', role: over.role === undefined ? 'owner' : over.role } }
  s.cols.config = Object.assign({}, over.config || {})
  if (!over.omitSmsnotify) s.cols.config.smsnotify = Object.assign({ dayBefore: true, cancel: true, dayBeforeAt: '17:30' }, over.smsnotify || {})
}

const FULL_SUB = {
  reserveSuccess: true, reserveCancel: true, reminder: true, reminderEnd: true,
  dayBefore: true, adminNew: true, adminCancel: false, adminReview: true
}

;(async () => {
  console.log('\nT1 首次保存：config 内无 subscribe 文档 → 走 set 新建（回归 -504002）')
  {
    const { store, res } = await run(base, { subscribe: Object.assign({}, FULL_SUB, { texts: { reminder: '快到了' } }) })
    check('返回成功 code=0', res.code === 0, res)
    check('回报 wrote 含 subscribe', Array.isArray(res.data && res.data.wrote) && res.data.wrote.indexOf('subscribe') >= 0, res.data)
    const doc = store.cols.config.subscribe || {}
    check('subscribe 文档已创建', !!store.cols.config.subscribe)
    check('8 个订阅开关全部落库', Object.keys(FULL_SUB).every(k => doc[k] === FULL_SUB[k]), doc)
    check('texts 落库', (doc.texts || {}).reminder === '快到了', doc.texts)
    check('写入的 data 不含 _id', !('_id' in doc), doc)
  }

  console.log('\nT2 二次保存：subscribe 已存在 → 走 update，只覆盖传入字段')
  {
    const existing = { subscribe: { reserveSuccess: true, adminCancel: true, texts: { reminder: '旧文案' }, legacy: 'KEEP' } }
    const { store, res } = await run(s => base(s, { config: existing }), { subscribe: { dayBefore: false, adminCancel: false } })
    check('返回成功 code=0', res.code === 0, res)
    const doc = store.cols.config.subscribe
    check('传入字段被更新（dayBefore=false）', doc.dayBefore === false, doc)
    check('传入字段被更新（adminCancel=false）', doc.adminCancel === false, doc)
    check('未传字段保留（reserveSuccess=true）', doc.reserveSuccess === true, doc)
    check('未传字段保留（texts 旧值）', (doc.texts || {}).reminder === '旧文案', doc.texts)
    check('未传字段保留（legacy 自定义字段）', doc.legacy === 'KEEP', doc)
  }

  console.log('\nT3 subscribe 传空对象（无可识别字段）→ 不炸')
  {
    const { res } = await run(base, { subscribe: {} })
    check('返回成功 code=0（不是异常）', res.code === 0, res)
  }

  console.log('\nT4 mp 文档不存在 → 走 set 新建')
  {
    const { store, res } = await run(base, { mp: { adminNew: true, reserveCancel: false } })
    check('返回成功 code=0', res.code === 0, res)
    const doc = store.cols.config.mp || {}
    check('mp 文档已创建且不含 _id', !('_id' in doc) && doc.adminNew === true && doc.reserveCancel === false, doc)
  }

  console.log('\nT5 smsnotify 文档不存在 → 走 set 新建；新字段 + 时刻校验生效')
  {
    const s = s2 => { base(s2, { omitSmsnotify: true }); delete s2.cols.config.smsnotify }
    const { store, res } = await run(s, {
      sms: {
        dayBefore: true, cancel: true, skipSmsIfWxOk: true, cancelDelay: 5, dayBeforeWindow: 240,
        dayBeforeAt: '18:00', approachingWhen: 'after', approachingOffset: 30
      }
    })
    check('返回成功 code=0', res.code === 0, res)
    const doc = store.cols.config.smsnotify || {}
    check('新建成功且不含 _id', !('_id' in doc) && !!store.cols.config.smsnotify, doc)
    check('dayBeforeAt 合法值写入', doc.dayBeforeAt === '18:00', doc)
    check('skipSmsIfWxOk 写入', doc.skipSmsIfWxOk === true, doc)
    check('cancelDelay 写入', doc.cancelDelay === 5, doc)
    check('dayBeforeWindow 写入', doc.dayBeforeWindow === 240, doc)
    check('approachingWhen/Offset 写入', doc.approachingWhen === 'after' && doc.approachingOffset === 30, doc)
  }

  console.log('\nT6 非法值被丢弃（dayBeforeAt 格式错 / approachingWhen 非法）')
  {
    const existing = { smsnotify: { dayBeforeAt: '17:30' } }
    const { store, res } = await run(s => base(s, { config: existing }), { sms: { dayBeforeAt: '25:99', approachingWhen: 'whenever' } })
    check('返回成功 code=0', res.code === 0, res)
    const doc = store.cols.config.smsnotify
    check('非法 dayBeforeAt 未覆盖原值', doc.dayBeforeAt === '17:30', doc)
    check('非法 approachingWhen 未写入', doc.approachingWhen === undefined, doc)
  }

  console.log('\nT7 非 owner（manager）→ 拒绝且不写库')
  {
    const { store, res } = await run(s => base(s, { role: 'manager' }), { subscribe: { dayBefore: true } })
    check('返回失败', res.code !== 0, res)
    check('提示仅超级管理员', /仅超级管理员/.test(res.message || ''), res)
    check('未创建 subscribe 文档', !store.cols.config.subscribe, store.cols.config)
  }

  console.log('\nT8 无任何身份记录 → 拒绝且不写库')
  {
    const { store, res } = await run(s => { s.openid = 'oNobody'; s.cols.admins = {}; s.cols.config = {} }, { sms: { dayBefore: true } })
    check('返回失败', res.code !== 0, res)
    check('未写库', Object.keys(store.cols.config || {}).length === 0, store.cols.config)
  }

  console.log(`\n===== 结果：通过 ${state.pass} / 失败 ${state.fail} =====`)
  process.exit(state.fail ? 1 : 0)
})().catch(e => { console.error('测试脚本自身出错：', e); process.exit(2) })
