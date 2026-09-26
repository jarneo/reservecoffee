// 本地自检桩：模拟 CloudBase 云函数运行时（仅供 node -e 加载校验，不参与部署）
const DB = global.__MOCK_DB__ || {}
const callLog = (global.__CALL_LOG__ = [])
function matchOne(v, c) {
  if (c && typeof c === 'object' && c.__op) {
    switch (c.__op) {
      case 'neq': return v !== c.v
      case 'in':  return c.v.indexOf(v) >= 0
      case 'gte': return String(v) >= String(c.v)
      case 'lte': return String(v) <= String(c.v)
      case 'and': return matchOne(v, { __op: 'gte', v: c.v }) && (c.other ? matchOne(v, c.other) : true)
      default:    return true
    }
  }
  return v === c
}
const cloud = {
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init() {},
  getWXContext: () => ({ OPENID: global.__MOCK_OPENID__ || 'mock-openid' }),
  database() {
    return {
      command: _,
      collection(name) {
        let matched = (DB[name] || []).slice()
        const chain = {
          where(q) {
            matched = matched.filter(r => Object.keys(q).every(k => matchOne(r[k], q[k])))
            return chain
          },
          orderBy(f) { matched.sort((a, b) => (String(a[f]) < String(b[f]) ? -1 : String(a[f]) > String(b[f]) ? 1 : 0)); return chain },
          skip(n) { matched = matched.slice(n); return chain },
          limit(n) { matched = matched.slice(0, n); return chain },
          get: async () => { callLog.push({ name, n: matched.length }); return { data: matched.slice() } },
          doc(id) { return { get: async () => { callLog.push({ name, doc: id }); return { data: (DB[name] || []).find(r => r._id === id) || null } } } }
        }
        return chain
      }
    }
  },
  getTempFileURL: async ({ fileList }) => {
    callLog.push({ getTempFileURL: (fileList || []).length })
    return { fileList: (fileList || []).map(f => ({ fileID: f, tempFileURL: `https://636c-x.tcb.qcloud.la/${f}?sign=abc&t=123` })) }
  }
}
const _ = {
  neq: v => ({ __op: 'neq', v }),
  in: v => ({ __op: 'in', v }),
  gte: v => ({ __op: 'gte', v, and: (other) => ({ __op: 'and', v, other }) }),
  lte: v => ({ __op: 'lte', v })
}
_.aggregate = new Proxy({}, { get: () => () => ({ __op: 'agg' }) })
cloud.command = _
module.exports = cloud
