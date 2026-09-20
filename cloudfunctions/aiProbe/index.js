// 临时探针：验证当前微信云开发环境下，云函数调用大模型的**可用路径**。绕过身份守卫，仅用于联调核对。
//
// 背景（2026-09-21 实测）：此前报 `cloud.extend.AI 未定义`、wx-server-sdk=2.7.2。
// 官方两条服务端路径：
//   A) wx-server-sdk（≥3.0.5-beta.1）→ cloud.ai()      —— 注意 'cloud.extend.AI' 是小程序端形态，云函数端不保证存在
//   B) @cloudbase/node-sdk（≥3.16.0）→ app.ai()        —— init({}) 不传 env，v3+ 自动用当前云函数环境
//
// 用法：{} 跑完整矩阵；{ provider:'hunyuan-v3', model:'hy3' } 只测指定组合。
// 判定：取 cases 中 ok===true 的 via + provider + model。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const DEFAULT_MODEL = process.env.AI_MODEL || 'hy3'
const PROVIDERS = ['hunyuan-v3', 'cloudbase']

function pkgVer(name) {
  try { return require(name + '/package.json').version } catch (e) { return '(未安装)' }
}

// 路径 A：wx-server-sdk
function aiFromWxSdk() {
  try {
    if (typeof cloud.ai === 'function') return { ai: cloud.ai(), via: 'wx-server-sdk:cloud.ai()' }
  } catch (e) { /* ignore */ }
  if (cloud.extend && cloud.extend.AI) return { ai: cloud.extend.AI, via: 'wx-server-sdk:cloud.extend.AI' }
  return { ai: null, via: null }
}

// 路径 B：@cloudbase/node-sdk（不传 env，v3+ 自动取当前云函数环境）
function aiFromNodeSdk() {
  try {
    const tcb = require('@cloudbase/node-sdk')
    const app = tcb.init({ timeout: 60000 })
    if (typeof app.ai === 'function') return { ai: app.ai(), via: '@cloudbase/node-sdk:app.ai()' }
  } catch (e) { /* ignore */ }
  return { ai: null, via: null }
}

async function probeOne(ai, via, provider, model) {
  const r = { via, provider, model, ok: false, stage: 'createModel' }
  let m
  try {
    m = ai.createModel(provider)
  } catch (e) {
    r.error = e && (e.message || String(e))
    return r
  }
  r.stage = 'generateText'
  try {
    // 云函数端参数为平铺形态（小程序端才需要 { data: {...} } 包裹）
    const resp = await m.generateText({
      model,
      messages: [{ role: 'user', content: '只回复两个字：正常' }],
    })
    const text = (resp && resp.text) ||
      (resp && resp.data && resp.data.text) ||
      (resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || ''
    r.ok = true
    r.stage = 'done'
    r.textSample = String(text).slice(0, 60)
    r.usage = (resp && resp.usage) || null
    r.respKeys = resp ? Object.keys(resp) : []
    return r
  } catch (e) {
    r.error = e && (e.message || String(e))
    r.errorCode = e && (e.errCode || e.code)
    return r
  }
}

exports.main = async (event = {}) => {
  const wx = aiFromWxSdk()
  const node = aiFromNodeSdk()
  const out = {
    wxServerSdk: pkgVer('wx-server-sdk'),
    cloudbaseNodeSdk: pkgVer('@cloudbase/node-sdk'),
    entryWxSdk: wx.via,
    entryNodeSdk: node.via,
    cases: [],
  }
  const entries = []
  if (wx.ai) entries.push(wx)
  if (node.ai) entries.push(node)
  if (!entries.length) {
    out.ok = false
    out.error = '两条入口都拿不到 AI 能力：cloud.ai()/cloud.extend.AI 与 app.ai() 均缺失'
    out.suggest = '把 wx-server-sdk 升到 ≥3.0.5-beta.1（或 @cloudbase/node-sdk ≥3.16.0）后重新部署'
    return out
  }
  const providers = event.provider ? [event.provider] : PROVIDERS
  const model = event.model || DEFAULT_MODEL
  for (const e of entries) {
    for (const p of providers) out.cases.push(await probeOne(e.ai, e.via, p, model))
  }
  const win = out.cases.find(c => c.ok)
  out.ok = !!win
  out.verdict = win
    ? `可用组合：${win.via} + provider=${win.provider} + model=${win.model}`
    : '全部组合失败，请把 cases 里的 error 发回排查'
  return out
}
