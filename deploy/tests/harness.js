// deploy/tests/harness.js — 云函数离线测试脚手架
// 在临时目录里放一个假的 node_modules/wx-server-sdk（cloud.database / cloud.openapi / startTransaction），
// 再把【真实】cloudfunctions/_lib/index.js（转成 lib.js）与被测函数 index.js 拷进去 require，
// 因此被测的是真实共享库逻辑；仅短信发送商（./sms）与微信网关被替换为可控桩。
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '../..')

// 极简内存数据库 + 假微信网关
const STUB_SDK = `
const S = global.__store
const OPS = {
  neq: v => ({ __op: 'neq', v }), lte: v => ({ __op: 'lte', v }), lt: v => ({ __op: 'lt', v }),
  gte: v => ({ __op: 'gte', v }), gt: v => ({ __op: 'gt', v }), eq: v => ({ __op: 'eq', v }),
  in: v => ({ __op: 'in', v }), and: v => ({ __op: 'and', v }), nin: v => ({ __op: 'nin', v })
}
function cmp(o, v, val) {
  switch (o) {
    case 'neq': return val !== v
    case 'lte': return val <= v
    case 'lt': return val < v
    case 'gte': return val >= v
    case 'gt': return val > v
    case 'eq': return val === v
    case 'in': return Array.isArray(v) && v.indexOf(val) >= 0
    case 'nin': return !(Array.isArray(v) && v.indexOf(val) >= 0)
    default: return true
  }
}
function test(doc, q) {
  for (const k of Object.keys(q || {})) {
    const cond = q[k]
    if (cond && typeof cond === 'object' && cond.__op === 'and') {
      if (!cond.v.every(c => Object.keys(c).every(kk => test(doc, { [kk]: c[kk] })))) return false
      continue
    }
    const val = doc[k]
    if (cond && typeof cond === 'object' && cond.__op) { if (!cmp(cond.__op, cond.v, val)) return false }
    else if (val !== cond) return false
  }
  return true
}
function colOf(name) { return (S.cols[name] = S.cols[name] || {}) }
// 真实 SDK 的约束：update / set 的 data 里带 _id 会抛 -501007「不能更新_id的值」（add 允许自定义 _id）。
// 桩里必须复刻这条，否则这类 bug 在离线测试里测不出来（真实环境表现为客户端 -504002）。
function idErr(kind) {
  const e = new Error('document.' + kind + ':fail -501007 invalid parameters. 不能更新_id的值')
  e.errCode = -501007
  return e
}
function makeApi(name) {
  const col = colOf(name)
  // 真实文档一律带 _id（存在 key 上），因此按 _id 查询（如 db.command.in(ids)）必须能命中
  const rows = q => Object.keys(col).map(k => Object.assign({ _id: k }, col[k])).filter(d => test(d, q))
  const clone = o => JSON.parse(JSON.stringify(o))
  // 链式查询：where(q).orderBy(k,dir).skip(n).limit(n).get()（where/orderBy/skip/limit 顺序任意）
  const query = (init) => {
    const st = Object.assign({ q: {}, order: [], limit: null, skip: 0 }, init)
    const api = {
      where(q2) { st.q = Object.assign(st.q, q2); return api },
      orderBy(key, dir) { st.order.push({ key, dir }); return api },
      limit(n) { st.limit = n; return api },
      skip(n) { st.skip = n || 0; return api },
      get: async () => {
        let list = rows(st.q)
        for (const o of st.order.slice().reverse()) {
          list = list.sort((a, b) => {
            const x = a[o.key], y = b[o.key]
            if (x === y) return 0
            const r = x > y ? 1 : -1
            return (o.dir === 'desc' || o.dir === -1) ? -r : r
          })
        }
        const off = st.skip || 0
        const take = st.limit == null ? 20 : st.limit
        return { data: list.slice(off, off + take).map(clone) }
      },
      count: async () => ({ total: rows(st.q).length })
    }
    return api
  }
  return Object.assign(query({}), {
    doc(id) {
      return {
        get: async () => ({ data: col[id] ? clone(Object.assign({ _id: id }, col[id])) : null }),
        update: async ({ data }) => {
          if (data && '_id' in data) throw idErr('update')
          col[id] = Object.assign({}, col[id], data); S.writes.push({ name, id, data }); return { stats: { updated: 1 } }
        },
        set: async ({ data }) => {
          if (data && '_id' in data) throw idErr('set')
          col[id] = Object.assign({}, data); S.writes.push({ name, id, data }); return {}
        },
        remove: async () => { delete col[id] }
      }
    },
    add: async ({ data }) => { const id = data._id || 'id' + (Object.keys(col).length + 1); col[id] = Object.assign({}, data); S.writes.push({ name, id, data }); return { _id: id } },
    count: async () => ({ total: Object.keys(col).length })
  })
}
const db = {
  command: OPS,
  collection: makeApi,
  createCollection: async () => ({}),
  startTransaction: async () => ({
    collection: makeApi,
    commit: async () => ({}),
    rollback: async () => ({})
  })
}
const cloud = {
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init() {},
  database: () => db,
  getWXContext: () => ({ OPENID: S.openid || 'oTest', APPID: 'wxmock' }),
  openapi: {
    subscribeMessage: {
      send: async ({ touser, templateId, data }) => {
        S.subscribeCalls.push({ touser, templateId, data })
        if (S.wx.failTemplates && S.wx.failTemplates.indexOf(templateId) >= 0) {
          const e = new Error('mock: user refused'); e.errCode = 43101; throw e
        }
        const allowed = S.wx.allowedKeys
        if (allowed) {
          const bad = Object.keys(data).filter(k => allowed.indexOf(k) < 0)
          if (bad.length) { const e = new Error('data.' + bad[0] + '.value invalid'); e.errCode = 47003; throw e }
        }
        if (S.wx.errCode) { const e = new Error('mock error'); e.errCode = S.wx.errCode; throw e }
        return { errCode: 0 }
      }
    }
  }
}
module.exports = cloud
`

// 短信发送桩（真实 sender 需要腾讯云 SDK，本地不装）
const STUB_SMS = `
module.exports = {
  loadConfig: async () => ({ templates: global.__store.smsTemplates }),
  sendTemplateSms: async ({ phone, templateId }) => {
    global.__store.smsCalls.push({ phone, templateId })
    if (global.__store.smsFail) return { ok: false, error: 'mock reject' }
    return { ok: true }
  },
  sendReservationSms: async () => ({ ok: true })
}
`

/**
 * 在沙箱里跑一次云函数
 * @param {string} fnName 云函数目录名
 * @param {function} setup 构造 store（cols / smsTemplates / wx 等）
 * @param {object} [opts] { event }  传给 main 的事件参数
 */
async function runFunction(fnName, setup, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-'))
  fs.mkdirSync(path.join(tmpDir, 'node_modules/wx-server-sdk'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'node_modules/wx-server-sdk/package.json'), JSON.stringify({ name: 'wx-server-sdk', main: 'index.js' }))
  fs.writeFileSync(path.join(tmpDir, 'node_modules/wx-server-sdk/index.js'), STUB_SDK)
  fs.writeFileSync(path.join(tmpDir, 'sms.js'), STUB_SMS)
  fs.copyFileSync(path.join(ROOT, 'cloudfunctions/_lib/index.js'), path.join(tmpDir, 'lib-src.js'))
  fs.writeFileSync(path.join(tmpDir, 'lib.js'), "module.exports = require('./lib-src.js')\n")
  fs.copyFileSync(path.join(ROOT, 'cloudfunctions', fnName, 'index.js'), path.join(tmpDir, 'index.js'))

  const store = {
    cols: {}, writes: [], subscribeCalls: [], smsCalls: [],
    wx: {}, smsTemplates: {}, smsFail: false, openid: 'oTest'
  }
  global.__store = store
  if (setup) setup(store)

  const mod = require(path.join(tmpDir, 'index.js'))
  const res = await mod.main(opts.event || {})
  return { store, res }
}

function makeChecker() {
  const state = { pass: 0, fail: 0 }
  const check = (name, cond, extra) => {
    if (cond) { state.pass++; console.log('  ✓ ' + name) }
    else { state.fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
  }
  return { check, state }
}

// 北京时间辅助（与生产代码同源算法）
function bjNow() {
  const t = new Date(Date.now() + 8 * 3600 * 1000)
  return {
    date: `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`,
    min: t.getUTCHours() * 60 + t.getUTCMinutes(),
    hhmm: `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`
  }
}
function plusDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}
// 当日分钟数 → 'HH:mm'（用于构造「当前时刻之前 N 分钟」的配置值）
function hhmmFromMin(min) {
  const m = Math.max(0, Math.min(1439, Math.floor(min)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

module.exports = { runFunction, makeChecker, bjNow, plusDays, hhmmFromMin }
