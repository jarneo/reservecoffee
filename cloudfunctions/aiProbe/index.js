// 临时探针：验证当前云开发环境下，云函数调用大模型的**可用路径**与**JSON 契约稳定性**。绕过身份守卫，仅用于联调。
//
// 【2026-09-21 实测结论】
//   ✔ wx-server-sdk(4.0.2):cloud.ai() + provider=hunyuan-exp + model=hunyuan-turbos-latest → ok
//   ✔ wx-server-sdk(4.0.2):cloud.ai() + provider=hunyuan-v3  + model=hy3                   → ok
//   ✘ @cloudbase/node-sdk(3.18.3):app.ai() + 任意 provider                                  → HTTP 404（勿走）
//   ✘ wx-server-sdk:cloud.extend.AI                                                          → 小程序端形态，云函数端不存在
//
// 用法：
//   {}                                             跑 SDK/入口矩阵（基础）
//   { provider:'hunyuan-exp', model:'hunyuan-turbos-latest' }  只测指定组合
//   { mode:'full', utterance:'明天下午两点两个人' }    复现 aiReserve 完整链路（真实场次 + JSON 契约 + 解析校验）
// 联调完成后可删除本函数。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const DEFAULT_MODEL = process.env.AI_MODEL || 'hy3'
const PROVIDERS = ['hunyuan-exp', 'hunyuan-v3']

function pkgVer(name) {
  try { return require(name + '/package.json').version } catch (e) { return '(未安装)' }
}

function aiFromWxSdk() {
  try {
    if (typeof cloud.ai === 'function') return { ai: cloud.ai(), via: 'wx-server-sdk:cloud.ai()' }
  } catch (e) { /* ignore */ }
  if (cloud.extend && cloud.extend.AI) return { ai: cloud.extend.AI, via: 'wx-server-sdk:cloud.extend.AI' }
  return { ai: null, via: null }
}

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

// ===== full 模式：复现 aiReserve 的完整链路，验证「模型能否稳定吐出可解析 JSON」=====
function ymd(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function addDays(n) {
  const d = new Date(); d.setDate(d.getDate() + n); return ymd(d)
}

async function loadAvailability() {
  const db = cloud.database()
  const today = ymd(new Date())
  const maxWin = addDays(30)
  let proj
  try {
    proj = await db.collection('projects').where({ published: true }).orderBy('createdAt', 'asc').get()
  } catch (e) { return '(可用性获取失败：' + (e && e.message) + ')' }
  const projects = proj.data || []
  const lines = []
  for (const p of projects) {
    if (p.paused) { lines.push(`- ${p.name}：当前已暂停预约`); continue }
    let sch
    try {
      sch = await db.collection('schedules').where({ projectId: p._id }).orderBy('date', 'asc').limit(200).get()
    } catch (e) { sch = { data: [] } }
    const open = (sch.data || []).filter(s => s.date >= today && s.date <= maxWin && !s.closed)
    const days = []
    for (const s of open) {
      const sess = (s.sessions || []).filter(x => !x.paused && (x.capacity - (x.booked || 0)) > 0)
      if (sess.length) days.push({ date: s.date, times: sess.map(x => `${x.start}-${x.end}`).join('、') })
    }
    if (!days.length) { lines.push(`- ${p.name}：近期暂无可约场次`); continue }
    const preview = days.slice(0, 6).map(d => `${d.date}（${d.times}）`).join('；')
    lines.push(`- ${p.name}（项目ID:${p._id}；单次最多${p.maxParty || 2}人）：可约日期示例 ${preview}${days.length > 6 ? ' 等' : ''}`)
  }
  return lines.join('\n')
}

function buildSystemPrompt(availability) {
  return [
    '你是「二曜路8号咖啡和清酒」小程序的 AI 预约助理，人设是一位温和、懂行、说话简洁的店员。',
    '你的职责：介绍店铺、解答预约疑问、引导到店、帮助顾客完成预约。',
    '',
    '【硬性规则】',
    '1. 绝不臆造项目、场次、日期或项目ID；一切以下方「当前可约情况」为准。',
    '2. 用户说的时间若没有对应场次，不要硬说有；按下方规则给最近可约或选项。',
    '3. 先确认、后下单：你只负责抽取信息并确认，真正下单由系统完成，你不要假装已经预约成功。',
    '4. 每次回复必须是【单个 JSON 对象】，不要加 markdown 代码块、不要多余解释。',
    '5. 不可约时表达共情，再给 2–3 个最近可约选项。',
    '',
    '【JSON 契约】',
    '{"intent":"chat","reply":"<对顾客的友好回答，纯中文>"}',
    '{"intent":"book","reply":"<确认/追问用语>","slots":{"projectId":"<从可约情况取项目ID，不知道则留空>","projectName":"<项目名，不知道则留空>","date":"<YYYY-MM-DD 或 今天/明天/周六 等，不知道则留空>","time":"<HH:mm 或 下午两点 等，不知道则留空>","partySize":<人数数字，不知道则留空>}}',
    '— 当顾客在预约 / 提供预约信息 / 问"能不能约"时，intent 用 "book" 并尽量填满 slots。',
    '— 当顾客只是聊天、问店铺/菜单/政策时，intent 用 "chat"。',
    '— 信息不全时，intent 仍用 "book"，reply 写明还缺什么（如"请问几位？""想约哪一天？"）。',
    '',
    '【时段间隙处理】',
    '用户说的时间附近（±60 分钟内）有场次，可直接吸附到最近场次并在 reply 说明"已为您调整到 X 场"；',
    '若差距 >60 分钟或当天无合适场次，reply 给出 2–3 个真实可选项让顾客选。',
    '',
    '【当前可约情况（实时，以此为准）】',
    availability || '(暂无可用性数据)'
  ].join('\n')
}

async function probeFull(event) {
  const provider = event.provider || 'hunyuan-exp'
  const model = event.model || 'hunyuan-turbos-latest'
  const utterance = event.utterance || '我想明天下午两点预约两个人的咖啡'
  const availability = await loadAvailability().catch(e => '(可用性获取失败)')
  const sys = buildSystemPrompt(availability)
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: utterance }]

  const out = { mode: 'full', provider, model, utterance, availability }
  const entry = aiFromWxSdk()
  if (!entry.ai) { out.ok = false; out.error = 'cloud.ai() 入口缺失'; return out }
  try {
    const t0 = Date.now()
    const resp = await entry.ai.createModel(provider).generateText({ model, messages })
    out.durationMs = Date.now() - t0
    const text = (resp && (resp.text || (resp.data && resp.data.text))) || ''
    out.text = String(text).slice(0, 800)
    out.usage = (resp && resp.usage) || null
    // 校验能否解析为契约 JSON（与 aiReserve 的 parseModel 同逻辑）
    let parsed = null
    try {
      const s = String(text).trim()
      const a = s.indexOf('{'); const b = s.lastIndexOf('}')
      if (a >= 0 && b > a) parsed = JSON.parse(s.slice(a, b + 1))
    } catch (e) { out.parseError = e.message }
    out.parsed = parsed
    out.jsonOk = !!(parsed && typeof parsed.intent === 'string')
    out.slots = (parsed && parsed.slots) || null
    out.ok = out.jsonOk
    return out
  } catch (e) {
    out.ok = false
    out.error = e && (e.message || String(e))
    out.errorCode = e && (e.errCode || e.code)
    return out
  }
}

exports.main = async (event = {}) => {
  if (event.mode === 'full') return probeFull(event)

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
