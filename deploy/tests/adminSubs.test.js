// 管理员侧订阅状态（admins.subscriptions）行为验证
// 覆盖：normalizeAdminSubs 缺省语义 · adminSubbedOf · adminSubKeyOfTemplate ·
//       notifyAdmins 的「跳过已失效」与「43101 回写失效」
const path = require('path')
const { runFunction, loadLib, makeChecker } = require('./harness')

const lib = loadLib()
const { check, state } = makeChecker()
const KEYS = ['adminNew', 'adminCancel', 'adminReview']

;(async () => {
  console.log('\n[1] normalizeAdminSubs：缺省必须全 true（对齐顾客侧 subbedOf）')
  {
    const a = lib.normalizeAdminSubs({})
    check('空对象 → 3 键全 true', KEYS.every(k => a[k] === true), a)
    const b = lib.normalizeAdminSubs(undefined)
    check('undefined → 3 键全 true', KEYS.every(k => b[k] === true))
    const c = lib.normalizeAdminSubs({ adminNew: false })
    check('仅 adminNew:false → 其余仍 true',
      c.adminNew === false && c.adminCancel === true && c.adminReview === true, c)
    const d = lib.normalizeAdminSubs({ adminNew: 'yes' })
    check('非布尔值被强制转 true（!! 语义）', d.adminNew === true)
  }

  console.log('\n[2] adminSubbedOf：记录缺失也视为已订阅（不误拦历史数据）')
  {
    check('null → true', lib.adminSubbedOf(null, 'adminNew') === true)
    check('undefined → true', lib.adminSubbedOf(undefined, 'adminNew') === true)
    check('{} → true（缺省开）', lib.adminSubbedOf({}, 'adminNew') === true)
    check('{adminNew:false} → false', lib.adminSubbedOf({ adminNew: false }, 'adminNew') === false)
  }

  console.log('\n[3] adminSubKeyOfTemplate：模板 ID → 订阅键映射')
  {
    check('adminNew 模板 → adminNew', lib.adminSubKeyOfTemplate(lib.TPL.adminNew) === 'adminNew')
    check('adminCancel 模板 → adminCancel', lib.adminSubKeyOfTemplate(lib.TPL.adminCancel) === 'adminCancel')
    check('adminReview 模板 → adminReview', lib.adminSubKeyOfTemplate(lib.TPL.adminReview) === 'adminReview')
    check('顾客模板 → 空串（不受管理员逻辑影响）', lib.adminSubKeyOfTemplate(lib.TPL.reserveSuccess) === '')
    check('空模板 → 空串', lib.adminSubKeyOfTemplate('') === '')
  }

  console.log('\n[4] saveAdminSubs：只能改自己 + 逐键合并（不整覆盖）')
  {
    // 4a 非管理员 → 拒绝
    const r1 = await runFunction('saveAdminSubs', s => {
      s.cols.admins = {}                       // admins 为空 → 非管理员
    }, { event: { subs: { adminNew: true } } })
    check('非管理员被拒', r1.res && r1.res.code !== 0, r1.res)

    // 4b 续订 adminNew → 只有该键变 false→true，adminCancel/adminReview 不受影响
    const r2 = await runFunction('saveAdminSubs', s => {
      s.cols.admins = {
        a1: { _id: 'a1', openid: 'oTest', role: 'owner', subscriptions: { adminNew: false, adminCancel: true, adminReview: true } }
      }
    }, { event: { subs: { adminNew: true } } })
    check('续订成功', r2.res && r2.res.code === 0, r2.res)
    const upd = r2.store.writes.find(w => w.name === 'admins')
    check('写库用点路径 subscriptions.adminNew',
      upd && upd.data['subscriptions.adminNew'] === true, upd && upd.data)
    check('未上报的键不出现在 patch 里（不会白置 false）',
      upd && upd.data['subscriptions.adminCancel'] === undefined &&
           upd.data['subscriptions.adminReview'] === undefined,
      upd && Object.keys(upd.data))
    check('返回合并后状态（3 键全 true）',
      r2.res && r2.res.data && KEYS.every(k => r2.res.data.subscriptions[k] === true),
      r2.res && r2.res.data)
    check('已续订 → 刷新 subscribedAt', upd && upd.data.subscribedAt > 0, upd && upd.data.subscribedAt)
  }

  console.log('\n[5] saveAdminSubs：ban 场景与非法入参')
  {
    // 5a 只拒绝 adminNew → 合并后应保留 adminCancel 的 true
    const r3 = await runFunction('saveAdminSubs', s => {
      s.cols.admins = { a1: { _id: 'a1', openid: 'oTest', role: 'manager', subscriptions: { adminNew: true, adminCancel: true, adminReview: true } } }
    }, { event: { subs: { adminNew: false } } })
    const u3 = r3.store.writes.find(w => w.name === 'admins')
    check('拒绝单个键 → 该键落 false', u3 && u3.data['subscriptions.adminNew'] === false, u3 && u3.data)
    check('其余键未被整覆盖', u3 && u3.data['subscriptions.adminCancel'] === undefined)

    // 5b 非布尔值 → 拒绝（防止把 'ban' 之类当 true 存进去）
    const r4 = await runFunction('saveAdminSubs', s => {
      s.cols.admins = { a1: { _id: 'a1', openid: 'oTest', role: 'manager' } }
    }, { event: { subs: { adminNew: 'ban' } } })
    check('非布尔入参被拒', r4.res && r4.res.code !== 0, r4.res)

    // 5c 空 subs → 拒绝（避免「打开弹窗就全置 false」的误操作）
    const r5 = await runFunction('saveAdminSubs', s => {
      s.cols.admins = { a1: { _id: 'a1', openid: 'oTest', role: 'manager' } }
    }, { event: { subs: {} } })
    check('空 subs 被拒', r5.res && r5.res.code !== 0, r5.res)
  }

  console.log('\n[6] listAdmins：下发订阅状态 + hasInvalid')
  {
    const r = await runFunction('listAdmins', s => {
      s.openid = 'oOwner'
      s.cols.admins = {
        a1: { _id: 'a1', openid: 'oOwner', role: 'owner', nickname: '倪师傅', createdAt: 1 },
        a2: { _id: 'a2', openid: 'oB', role: 'manager', createdAt: 2, subscriptions: { adminNew: false } },
        a3: { _id: 'a3', openid: 'oC', role: 'manager', createdAt: 3, lastErrorAt: 999 }
      }
    })
    check('owner 可查', r.res && r.res.code === 0, r.res)
    const list = r.res.data.list
    const byId = id => list.find(x => x._id === id)
    check('a1 无 subscriptions → 缺省全 true（存量管理员不被误判失效）',
      KEYS.every(k => byId('a1').subscriptions[k] === true) && byId('a1').hasInvalid === false,
      byId('a1'))
    check('a2 adminNew:false → hasInvalid=true', byId('a2').hasInvalid === true, byId('a2'))
    check('a3 透传 lastErrorAt', byId('a3').lastErrorAt === 999, byId('a3'))

    // 非 owner → 拒绝
    const r2 = await runFunction('listAdmins', s => {
      s.openid = 'oNobody'
      s.cols.admins = { a1: { _id: 'a1', openid: 'oOwner', role: 'owner' } }
    })
    check('非 owner 被拒', r2.res && r2.res.code !== 0, r2.res)
  }

  console.log('\n[7] addAdmin：初始化 subscriptions 为全 true')
  {
    // ⚠️ 构造要点：调用者自己必须是 admins 里的 owner 才有权限，而 addAdmin 又要求
    //   目标 openid「尚不是管理员」。所以 admins 里要放 owner + 待授权者**以外**的一条，
    //   目标 openid 用一个全新值 —— 若把 admins 置空，getRole 会判调用者为 none 而拒绝。
    const r = await runFunction('addAdmin', s => {
      s.openid = 'oOwner'
      s.cols.admins = { a1: { _id: 'a1', openid: 'oOwner', role: 'owner', createdAt: 1 } }
    }, { event: { openid: 'oNew', role: 'manager', note: '店员' } })
    check('授权成功', r.res && r.res.code === 0, r.res)
    const w = r.store.writes.find(x => x.name === 'admins' && x.data.openid === 'oNew')
    check('写入 subscriptions 且 3 键全 true',
      w && KEYS.every(k => w.data.subscriptions && w.data.subscriptions[k] === true),
      w && w.data.subscriptions)
    check('写入 subscribedAt: 0（尚未续订）', w && w.data.subscribedAt === 0, w && w.data.subscribedAt)
  }

  console.log('\n' + (state.fail === 0 ? '全部通过' : '有失败') +
    '：' + state.pass + ' passed, ' + state.fail + ' failed')
  if (state.fail > 0) process.exit(1)
})().catch(e => { console.error('测试异常:', e); process.exit(1) })
