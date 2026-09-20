// aiReserve — AI 智能预约（对话 + 信息抽取 + 真实可用性校验）
//
// 设计原则（详见 ai-reserve-spec.md）：
//   1) AI 只负责【自然语言理解 + 接待话术】，不做任何写库；
//      真正的预约落库由【前端在用户确认后调用 createReservation】完成（复用既有事务/通知链路）。
//   2) 因此本函数对自动化测试是【只读安全】的——批量测试直接调用也不会污染 reservations 数据。
//   3) 预约时段的有效性（满员/过期/暂停/超提前量）最终由 createReservation 事务判定；
//      本函数在抽取阶段做轻量预校验，给出友好追问/改荐，提升一次成功率。
//
// 返回结构：
//   { intent:'chat',  reply }                  普通问答
//   { intent:'ask',   reply }                  信息不全 / 不可约，需继续追问（reply 已含可选项）
//   { intent:'confirm', reply, confirmation, profile }  已解析出可约时段，前端据此渲染确认卡
const { db, _, COL, ok, fail, wxCtx, ymd, addDays, bjTs } = require('./lib')
const KB = require('./kb')

// AI 模型 / provider 由 callAI 内的 process.env.AI_MODEL / AI_PROVIDER 控制（缺省见 callAI）。
// 注：成长计划「一期模型下线、自动切 hy3」等说法存疑，最终以控制台「生文模型」实际启用的模型名为准；
// 启用后在云函数环境变量设 AI_MODEL / AI_PROVIDER 即可，无需改代码。

// ===== 1) 真实可用性摘要（注入 system prompt，避免模型臆造场次）=====
async function loadAvailability() {
  const today = ymd(new Date())
  const maxWin = addDays(30)
  let proj
  try {
    proj = await db.collection(COL.projects).where({ published: true, deleted: _.neq(true) }).orderBy('createdAt', 'asc').get()
  } catch (e) { return '(可用性获取失败)' }
  const projects = proj.data || []
  const lines = []
  for (const p of projects) {
    if (p.paused) { lines.push(`- ${p.name}：当前已暂停预约`); continue }
    let sch
    try {
      sch = await db.collection(COL.schedules).where({ projectId: p._id }).orderBy('date', 'asc').limit(200).get()
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

// ===== 2) System Prompt 构造 =====
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
    '【店铺知识】',
    KB.store || '(店铺知识未配置)',
    '',
    '【常见问题】',
    KB.faq || '(FAQ 未配置)',
    '',
    '【项目与菜单】',
    KB.menu || '(菜单知识未配置)',
    '',
    '【当前可约情况（实时，以此为准）】',
    availability || '(暂无可用性数据)'
  ].join('\n')
}

// ===== 3) 调用 CloudBase AI =====
// 【2026-09-21 运行时实测（探针 aiProbe，同一环境同一依赖）】
//   ✔ wx-server-sdk(4.0.2):cloud.ai()   + provider=hunyuan-exp + model=hunyuan-turbos-latest → ok（22 tokens）
//   ✔ wx-server-sdk(4.0.2):cloud.ai()   + provider=hunyuan-v3  + model=hy3                   → ok
//   ✘ @cloudbase/node-sdk(3.18.3):app.ai() + 任意 provider                                    → HTTP 404（本环境不可用，勿走）
// 结论：必须使用 wx-server-sdk 的 cloud.ai() 入口。注意 'cloud.extend.AI' 是小程序端形态，云函数端不存在。
// 失败一律抛出，由主入口统一转成 fail('AI 服务暂不可用：…')，前端降级兜底。
// provider / model 可用云函数环境变量 AI_PROVIDER / AI_MODEL 覆盖，无需改代码。
async function callAI(messages) {
  const provider = process.env.AI_PROVIDER || 'hunyuan-exp'
  const model = process.env.AI_MODEL || 'hunyuan-turbos-latest'
  const cloud = require('wx-server-sdk')
  let ai = null
  if (typeof cloud.ai === 'function') ai = cloud.ai()
  else if (cloud.extend && cloud.extend.AI) ai = cloud.extend.AI // 兜底（云端若降级到旧版仍可尝试）
  if (!ai) throw new Error('当前 wx-server-sdk 无 cloud.ai() 入口，请确认依赖版本 ≥3.0.5-beta.1')

  const m = ai.createModel(provider)
  // 云函数端为平铺参数形态（小程序端才需要 { data:{...} } 包裹）
  const resp = await m.generateText({ model, messages })
  const text = (resp && (resp.text || (resp.data && resp.data.text))) ||
    (resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || ''
  if (!text) throw new Error('AI 返回为空')
  return text
}

// 容错解析模型输出的 JSON（可能夹带多余文字）
function parseModel(text) {
  if (!text) return null
  const s = String(text).trim()
  const a = s.indexOf('{'); const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)) } catch (e) { /* ignore */ }
  }
  return null
}

// ===== 4) 日期 / 时间解析（把自然语言转成结构化值）=====
const WD = { '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '天': 0 }
function parseDate(str) {
  if (!str) return null
  const t = String(str).trim()
  const today = new Date()
  if (/^今\s*天$/.test(t)) return ymd(today)
  if (/^明\s*天$/.test(t)) return addDays(1)
  if (/^后\s*天$/.test(t)) return addDays(2)
  if (/^大\s*后\s*天$/.test(t)) return addDays(3)
  let m = t.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/)
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`
  m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/)
  if (m) { const y = today.getFullYear(); return `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}` }
  m = t.match(/(周|星期)\s*([一二三四五六日天])/)
  if (m) {
    const target = WD[m[2]]
    if (target != null) {
      let diff = (target - today.getDay() + 7) % 7
      if (diff === 0) diff = 7
      const d = new Date(); d.setDate(d.getDate() + diff)
      return ymd(d)
    }
  }
  m = t.match(/(\d+)\s*天\s*[后以]?/)
  if (m) return addDays(+m[1])
  return null
}

const CN_NUM = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 }
function parseTime(str) {
  if (!str) return null
  const t = String(str).trim()
  let m = t.match(/(\d{1,2}):(\d{2})/)
  if (m) return { hm: `${String(+m[1]).padStart(2, '0')}:${String(+m[2]).padStart(2, '0')}`, min: +m[1] * 60 + +m[2] }
  m = t.match(/(\d{1,2})\s*点\s*(\d{1,2})?\s*分?/)
  if (m) {
    let h = +m[1]; let min = m[2] ? +m[2] : 0
    if (/下午|晚上|傍晚/.test(t) && h < 12) h += 12
    if (/上午|早上/.test(t) && h === 12) h = 0
    return { hm: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, min: h * 60 + min }
  }
  m = t.match(/(下午|晚上|傍晚|上午|早上)?\s*(两|二|三|四|五|六|七|八|九|十|十一|十二|一)\s*点\s*(半)?/)
  if (m) {
    let h = CN_NUM[m[2]] || 0
    const pm = /下午|晚上|傍晚/.test(t); const am = /上午|早上/.test(t)
    if (pm && h < 12) h += 12
    if (am && h === 12) h = 0
    const min = m[3] ? 30 : 0
    return { hm: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, min: h * 60 + min }
  }
  return null
}

// ===== 5) 预约解析（真实校验，仅抽取 + 判定，不写库）=====
async function resolveBooking(slots, ctxProjectId) {
  const projects = await db.collection(COL.projects).where({ published: true, deleted: _.neq(true) }).get()
  const list = projects.data || []

  // —— 项目匹配 ——
  let project = null
  if (slots.projectId) project = list.find(p => p._id === slots.projectId)
  else if (slots.projectName) {
    const name = String(slots.projectName).trim()
    const matches = list.filter(p => p.name === name || p.name.includes(name) || name.includes(p.name))
    if (matches.length === 1) project = matches[0]
    else if (matches.length > 1) return { ok: false, message: `您想预约哪一个呢？可选项：${matches.map(m => m.name).join('、')}` }
  }
  if (!project && ctxProjectId) project = list.find(p => p._id === ctxProjectId)
  if (!project) return { ok: false, message: `请问您想预约哪个项目呢？我们目前有：${list.map(p => p.name).join('、')}` }
  if (project.paused) return { ok: false, message: `「${project.name}」当前已暂停预约，您可以看看其他项目哦。` }

  // —— 日期 ——
  const date = parseDate(slots.date)
  if (!date) return { ok: false, message: `好的，您想约「${project.name}」。请问希望哪一天到店呢？（可以说"明天""周六"或具体日期）` }

  const sch = await db.collection(COL.schedules).where({ projectId: project._id, date }).get()
  const sched = (sch.data || [])[0]
  if (!sched || sched.closed) return { ok: false, message: `「${project.name}」在 ${date} 这天暂不开放预约，换一天试试？` }

  const sessions = (sched.sessions || []).filter(x => !x.paused)
  if (!sessions.length) return { ok: false, message: `「${project.name}」在 ${date} 这天没有可约场次。` }

  // —— 时间 / 时段间隙 ——
  const parsed = parseTime(slots.time)
  if (!parsed) return { ok: false, message: `您希望 ${date} 几点到店呢？该日可选场次：${sessions.map(x => x.start).join('、')}` }

  let sess = sessions.find(x => x.start === parsed.hm)
  let note = ''
  if (!sess) {
    let best = null, bestDiff = 1e9
    for (const x of sessions) {
      const [hh, mm] = x.start.split(':').map(Number)
      const diff = Math.abs(hh * 60 + mm - parsed.min)
      if (diff < bestDiff) { bestDiff = diff; best = x }
    }
    if (best && bestDiff <= 60) {
      sess = best
      note = `已将您说的 ${parsed.hm} 调整到最近场次 ${sess.start}`
    } else {
      const opts = sessions.map(x => `${x.start}-${x.end}`).join('、')
      return { ok: false, message: `${date} ${parsed.hm} 没有对应场次哦。最近的可用时段：${opts}。您选哪个？` }
    }
  }

  // 已过期（开场时间已过）→ 不呈现为可约
  if (!isNaN(bjTs(date, sess.start)) && bjTs(date, sess.start) < Date.now()) {
    return { ok: false, message: `${date} ${sess.start}-${sess.end} 这场已经过去了，换一场吧？可选：${sessions.map(x => x.start).join('、')}` }
  }
  // 满员
  const remaining = (sess.capacity || 0) - (sess.booked || 0)
  if (remaining <= 0) return { ok: false, message: `${date} ${sess.start}-${sess.end} 这场已约满，换一场试试？可选：${sessions.map(x => x.start).join('、')}` }

  let party = Number(slots.partySize) || 1
  const maxP = project.maxParty || 2
  if (party > maxP) return { ok: false, message: `「${project.name}」单次最多 ${maxP} 人哦，已为您按 ${maxP} 人预约可以吗？` }
  if (party < 1) party = 1

  return {
    ok: true,
    confirmation: {
      projectId: project._id, projectName: project.name, date,
      sessionId: sess.id, sessionStart: sess.start, sessionEnd: sess.end, partySize: party, note
    }
  }
}

// 读取顾客已授权资料（确认卡复用，不展示可编辑表单）
async function loadProfile(openid) {
  if (!openid) return { name: '', phone: '' }
  try {
    const r = await db.collection(COL.users).doc(openid).get()
    const d = r && r.data
    return { name: (d && d.name) || '', phone: (d && d.phone) || '' }
  } catch (e) { return { name: '', phone: '' } }
}

// ===== 6) 主入口 =====
exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('无法识别用户身份')

  const messages = Array.isArray(event.messages) ? event.messages
    .filter(m => m && m.role && typeof m.content === 'string')
    .slice(-20) : []
  const ctxProjectId = event.projectId || ''

  const availability = await loadAvailability().catch(() => '(可用性获取失败)')
  const sys = buildSystemPrompt(availability)
  const full = [{ role: 'system', content: sys }, ...messages]

  let text
  try {
    text = await callAI(full)
  } catch (e) {
    return fail('AI 服务暂不可用：' + (e && e.message ? e.message : '未知错误'))
  }

  const parsed = parseModel(text)
  if (!parsed || typeof parsed.intent !== 'string') {
    return ok({ intent: 'chat', reply: (text || '').slice(0, 500) || '抱歉，我没能理解，请再说一遍～' })
  }

  if (parsed.intent !== 'book') {
    return ok({ intent: 'chat', reply: parsed.reply || (text || '').slice(0, 500) || '好的～' })
  }

  const res = await resolveBooking(parsed.slots || {}, ctxProjectId)
  if (!res.ok) return ok({ intent: 'ask', reply: res.message })

  const profile = await loadProfile(OPENID)
  const c = res.confirmation
  const reply = `已为您查到可约时段：「${c.projectName}」${c.date} ${c.sessionStart}-${c.sessionEnd}，${c.partySize} 人位。${c.note ? c.note + '。' : ''}请确认预约信息～`
  return ok({ intent: 'confirm', reply, confirmation: c, profile })
}
