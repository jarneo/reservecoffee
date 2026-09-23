// aiCore.js — AI 预约助理「对话核心」（小程序端 aiReserve 与公众号端 mpChat 共用）
//
// 为什么抽出来：公众号要复用同一套 NLU / 可用性校验 / 知识库，但两端的身份来源不同
//   · 小程序端：openid = 小程序 openid（来自 wx-server-sdk 的 WXContext）
//   · 公众号端：openid = 公众号 openid（来自云开发消息推送注入的 FROM_OPENID）
// 核心对「openid」只做日志与资料读取，不依赖端侧上下文，因此可安全共用。
//
// 设计原则（详见 ai-reserve-spec.md）：
//   1) 只做【自然语言理解 + 可用性校验】，不写 reservations（落库由前端调 createReservation）；
//   2) 每轮对话写 aiLogs 一条（带 channel 区分来源），供「沟通→确认→预约成功」漏斗统计；
//   3) 单用户每日轮次上限由后台配置（config.ai），超限时返回友好文案且不消耗 AI。
//
// 部署：本文件由 deploy/sync-lib.sh 复制到需要的云函数目录（aiReserve / mpChat），
//       依赖同目录的 lib.js（共享库）与 kb.js + kb/*.md（知识库）。
const { db, _, COL, bjTs, loadAiLimits, checkAiQuota, incrAiQuota } = require('./lib')
const KB = require('./kb')

// ===== 北京时间工具 =====
// 云函数容器时区是 UTC，所以 bjNow() 返回的是「真实时刻 +8h」的 Date；
// 用 getUTC* 系列去读它，得到的正是北京墙钟时间（与 lib 的 bjTs 同一套约定）。
//
// ⚠️⚠️ 极易踩的坑：这个 Date **不能再交给 lib 的 bjYmd()/bjAddDays()**，那两个内部还会再 +8h。
//   曾经写法 `ymdBj(d) { return bjYmd(d || bjNow()) }` 就是「双重平移」：
//   北京时间 16:00 之后 +16h 会跨到次日 ⇒ 2026-09-23 21:00 实测 ymdBj() 返回 2026-09-24，
//   于是 AI 认错「今天」、把「明天」算成 09-25（真机复现，卡片日期整体+1 天）。
//   正确做法：本文件内的日期一律用「平移后的墙钟」直接格式化，绝不外委托 bjYmd/bjAddDays。
function bjNow() { return new Date(Date.now() + 8 * 3600 * 1000) }
function pad2(n) { return String(n).padStart(2, '0') }
// 把「已平移」的时刻按 UTC 取出北京日历
function fmtYmdShifted(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` }
function ymdBj(d) { return fmtYmdShifted(d || bjNow()) }
// 今天 + n 天（n 可为负）：一次平移，不做二次委托
function addDaysBj(n) { return fmtYmdShifted(new Date(Date.now() + (Number(n) || 0) * 86400000 + 8 * 3600 * 1000)) }
const WD_CN = ['日', '一', '二', '三', '四', '五', '六']

// 店铺人工联系方式（vx 与电话同号）。用途单一但很关键：
// 当顾客的需求超出系统能力边界（人数超单次上限、包场、当天临时情况）时，
// 必须给一个明确的「人工出口」，而不是把顾客推回常规预约页面自生自灭。
const SHOP_CONTACT = process.env.SHOP_CONTACT || '19292757851'
const shopContactLine = () => `如有疑问可加店铺微信或电话 ${SHOP_CONTACT}`
// ⭐ 必填资料提示（2026-09-24 口径）：预约必须留称呼 + 手机号，缺一项提交不了。
//   真机反馈：顾客问「不留昵称手机号能约吗」，AI 答「可以」→ 点进去才发现卡在表单上。
//   所以这条要同时出现在 ① system prompt（AI 口述）② 确认卡（前端展示）③ 公众号卡片描述里，三处同源。
const FILL_REQUIRED_NOTE = '称呼与手机号是必填项，请补充完整后才能提交预约（手机号仅用于本次预约的通知）'

// ===== 1) 真实可用性摘要（注入 system prompt，避免模型臆造场次）=====
async function loadAvailability() {
  const today = ymdBj()
  const maxWin = addDaysBj(30)
  let proj
  try {
    proj = await db.collection(COL.projects).where({ published: true, deleted: _.neq(true) }).orderBy('createdAt', 'asc').get()
  } catch (e) { return '(可用性获取失败)' }
  const projects = proj.data || []
  // ⚠️ 串行查排班会让首字延迟增加数百毫秒（公众号被动回复只有 5 秒预算）→ 改为并发查
  const schList = await Promise.all(projects.map(p => p.paused
    ? Promise.resolve({ data: [] })
    : db.collection(COL.schedules).where({ projectId: p._id }).orderBy('date', 'asc').limit(200)
      .get().catch(() => ({ data: [] }))
  ))
  const lines = []
  projects.forEach((p, i) => {
    if (p.paused) { lines.push(`- ${p.name}：当前已暂停预约`); return }
    const open = (schList[i].data || []).filter(s => s.date >= today && s.date <= maxWin && !s.closed)
    const days = []
    for (const s of open) {
      // 已开场/已结束的场次视为过期，不再呈现为可约
      const sess = (s.sessions || []).filter(x => !x.paused
        && (x.capacity - (x.booked || 0)) > 0
        && !(bjTs(s.date, x.start) < Date.now()))
      if (sess.length) days.push({ date: s.date, times: sess.map(x => `${x.start}-${x.end}`).join('、') })
    }
    if (!days.length) { lines.push(`- ${p.name}：近期暂无可约场次`); return }
    const preview = days.slice(0, 6).map(d => `${d.date}（${d.times}）`).join('；')
    lines.push(`- ${p.name}（项目ID:${p._id}；单次最多${p.maxParty || 2}人）：可约日期示例 ${preview}${days.length > 6 ? ' 等' : ''}`)
  })
  return lines.join('\n')
}

// 可用性短缓存（容器内复用，20 秒 TTL）。
// 为什么需要：公众号被动回复只有 5 秒预算，而可用性要查 1 + N 次库；缓一轮就能省下大部分延迟。
// 风险可控：真实容量校验在 createReservation 里仍会再做一次，最坏情况是极短时间内提示了已被抢走的场次。
const AVAIL_TTL_MS = 20000
let _availCache = { at: 0, text: '' }
async function loadAvailabilityCached() {
  const now = Date.now()
  if (_availCache.text && (now - _availCache.at) < AVAIL_TTL_MS) return _availCache.text
  const text = await loadAvailability()
  _availCache = { at: now, text }
  return text
}

// ===== 2) System Prompt 构造 =====
// channelExtra：渠道相关的补充规则（公众号端会额外注入「引导进小程序」的话术要求）
function buildSystemPrompt(availability, channelExtra) {
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
    '6. 营业时间类问题（"几点开门 / 营业到几点 / 今天几点能来 / 几点关门 / 营业时间"）不要给固定营业时间，直接读取下方「当前可约情况」中对应项目的可约日期与时段来回答（例："今天 X 项目 12:00-15:00 可预约，即营业至 15:00"）；若当天已无可约，说明已结束并给最近可约日期。',
    '7. 用户若提到某个具体场次但它在「当前可约情况」里查不到（已开场/过期/满员/未开放），明确告知「该场次已过期，无法预约」，并给出最近可约日期或时段，不要含糊说"暂未开放"。',
    '8. 顾客指定了日期但该日期在「当前可约情况」里查不到（未排班 / 已约满 / 已过期）时，回复必须先说清「您要求的「项目名」在 YYYY-MM-DD 没有可约场次」，再给最近可约日期；绝不可以在不说明的情况下默默推荐其他日期，那会让顾客以为自己要的那天还能约。',
    '9. 人数是必问信息：顾客没说人数时必须主动追问「请问一共几位？」，并在追问时一并说明该项目的单次上限（例："「法兰绒手冲咖啡预约」单次最多 2 人，请问一共几位？"）；绝不在人数未知时给出确认。',
    `10. 人数上限口径（重要）：单次上限由「当前可约情况」里每个项目标注的「单次最多 N 人」决定，这就是上限本身（不同项目上限不同，以标注为准，不要记成固定数字）。顾客说的人数超过上限时，照常给出预约确认，并按下面的原话模板说明：「单次上限 N 人，已按 N 位为您安排；因系统限制，无法单次预约 N 位以上。如您特殊要求，请直接联系店铺 vx / 电话 ${SHOP_CONTACT}」。**绝对不要**提「拆单 / 分两笔 / 分两次预约」，**也绝对不要**让顾客改用常规预约页面 —— 顾客要约的是一个人数，系统做不到就该在系统内按上限约成，剩下的人工沟通。`,
    '11. 日期一律以「当前可约情况」中的数据为准；你不需要自己推算日历。顾客问"今天/明天"时，直接用上方【当前时间】给出的日期。**禁止**输出「系统时间是……」这类说法，也**禁止**凭自己的记忆或日历改动「今天/明天」的具体日期 —— 上方给出的就是权威值，即使你觉得不是。',
    '12. 顾客用相对日期说法（今天/明天/后天/大后天/周六等）时，slots.date 必须原样填相对说法，**禁止自己换算成具体日期** —— 日历换算由系统完成（系统时间见下方【当前时间】）。只有顾客亲口说出具体日期时才填 YYYY-MM-DD。',
    '13. 历史对话里若出现过与【当前时间】不一致的日期（包括你自己之前说的），一律以【当前时间】为准作废旧说法，不要顺着历史继续算。',
    '14. 预约必填资料（重要）：预约必须留「称呼（昵称）」与「手机号」，**两项缺一不可**。顾客问"可以不留昵称吗 / 不留手机号能约吗 / 不想填手机号"时，**必须明确回答不可以**，并按这个口径说明：「称呼和手机号是预约的必填项，缺一项就没法下单。手机号**只会用于本次预约的通知**（到店提醒、时间变动等），您不用担心。」同时告诉他最快的填法：称呼点输入框可用微信昵称一键填入，手机号点「获取手机号」一键授权填入，两项也都支持手工填写。顾客**坚持不留手机号**时，请他联系店铺 vx / 电话 ' + SHOP_CONTACT + ' 由店员人工协助安排，不要说"可以不填"。',
    '',
    '【当前时间（北京时间，以此为准）】',
    `今天是 ${ymdBj()} 星期${WD_CN[bjNow().getUTCDay()]}，现在是 ${String(bjNow().getUTCHours()).padStart(2, '0')}:${String(bjNow().getUTCMinutes()).padStart(2, '0')}。`,
    `— 用户说的「今天/今日/当天」就是 ${ymdBj()}，「明天」就是 ${addDaysBj(1)}；回复中请直接使用具体日期，不要说"今天暂未开放"却列出今天的场次。`,
    '— 开场时间已过的场次已过期、不可再约（下方可约数据已过滤掉过期场次）。',
    '',
    channelExtra || '',
    '',
    '【JSON 契约】',
    '{"intent":"chat","reply":"<对顾客的友好回答，纯中文>"}',
    '{"intent":"book","reply":"<确认/追问用语>","slots":{"projectId":"<从可约情况取项目ID，不知道则留空>","projectName":"<项目名，不知道则留空>","date":"<YYYY-MM-DD，或 今天/当天/明日/周六 等相对表达，不知道则留空>","time":"<HH:mm 或 下午两点 等，不知道则留空>","partySize":<人数数字，不知道则留空>}}',
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
    '【品牌故事】',
    KB.story || '(品牌故事未配置)',
    '',
    '【当前可约情况（实时，以此为准）】',
    availability || '(暂无可用性数据)'
  ].join('\n')
}

// ===== 3) 调用 CloudBase AI =====
// 【2026-09-21 运行时实测（探针 aiProbe，同一环境同一依赖）】
//   ✔ wx-server-sdk(4.0.2):cloud.ai() + provider=hunyuan-exp + model=hunyuan-turbos-latest → ok
//   ✘ @cloudbase/node-sdk:app.ai() + 任意 provider → HTTP 404（本环境不可用，勿走）
// provider / model 可用环境变量 AI_PROVIDER / AI_MODEL 覆盖。
async function callAI(messages) {
  const provider = process.env.AI_PROVIDER || 'hunyuan-exp'
  const model = process.env.AI_MODEL || 'hunyuan-turbos-latest'
  const cloud = require('wx-server-sdk')
  let ai = null
  if (typeof cloud.ai === 'function') ai = cloud.ai()
  else if (cloud.extend && cloud.extend.AI) ai = cloud.extend.AI
  if (!ai) throw new Error('当前 wx-server-sdk 无 cloud.ai() 入口，请确认依赖版本 ≥3.0.5-beta.1')

  const m = ai.createModel(provider)
  const resp = await m.generateText({ model, messages })
  const text = (resp && (resp.text || (resp.data && resp.data.text))) ||
    (resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || ''
  if (!text) throw new Error('AI 返回为空')
  const usage = (resp && resp.usage) || (resp && resp.data && resp.data.usage) || null
  return { text, usage }
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

// ===== 4) 日期 / 时间解析 =====
const WD = { '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '天': 0 }
function parseDate(str) {
  if (!str) return null
  const t = String(str).trim()
  const today = bjNow()
  if (/^(今\s*天|今\s*日|当\s*天|今\s*儿|现\s*在|这\s*会\s*儿|此\s*刻)$/.test(t)) return ymdBj(today)
  if (/今\s*[天日儿]|当\s*天/.test(t)) return ymdBj(today)
  if (/^明\s*天$/.test(t)) return addDaysBj(1)
  if (/^后\s*天$/.test(t)) return addDaysBj(2)
  if (/^大\s*后\s*天$/.test(t)) return addDaysBj(3)
  let m = t.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/)
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`
  m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/)
  if (m) { const y = today.getUTCFullYear(); return `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}` }
  m = t.match(/(周|星期)\s*([一二三四五六日天])/)
  if (m) {
    const target = WD[m[2]]
    if (target != null) {
      let diff = (target - today.getUTCDay() + 7) % 7
      if (diff === 0) diff = 7
      const d = bjNow(); d.setUTCDate(d.getUTCDate() + diff)
      return ymdBj(d)
    }
  }
  m = t.match(/(\d+)\s*天\s*[后以]?/)
  if (m) return addDaysBj(+m[1])
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

// 人数解析（双保险 + 取大值）：
//   ① 模型抽取的 slots.partySize；
//   ② 从用户原话确定性解析 —— "两位""3人""一共四个人""2位"。
// ⚠️ 为什么是【取较大值】而不是"模型优先"（这里踩过坑）：
//   知识库里写着「单次预约上限 2 人」，模型会拿这个口径去"纠正"顾客 —— 顾客明明说"5个人"，
//   模型却把 slots.partySize 填成 2。只信模型值 ⇒ 永远触发不了「超上限」提示，
//   顾客会拿到一张 2 人位确认卡，却不知道自己说的 5 位被静默改小了（线上复现，日志可查）。
//   原话解析是确定性的，取大值能保证"顾客到底说了多少人"被如实反映。
//   代价：若原话里出现与本意无关的"N 人"（如"你们最多 8 位，我们 3 位"），可能取偏大 ——
//   但取偏大的后果只是多一句上限说明，比静默改小安全得多。
function parsePartySize(raw, text) {
  const n = Number(raw)
  const fromModel = (Number.isFinite(n) && n >= 1) ? Math.min(50, Math.floor(n)) : 0
  const s = String(text || '')
  let fromText = 0
  let m = s.match(/(\d{1,2})\s*(?:人|位|个)/)
  if (m) fromText = parseInt(m[1], 10)
  if (!fromText) {
    m = s.match(/(十一|十二|两|二|一|三|四|五|六|七|八|九|十)\s*(?:人|位|个)/)
    if (m) fromText = CN_NUM[m[1]] || 1
  }
  const v = Math.max(fromModel, fromText)
  return v ? Math.min(50, v) : 0
}

// 查某项目在 fromDate 之后（+30 天窗口内）第一个仍有可约场次的日期
async function nearestOpenDays(projectId, fromDateStr) {
  try {
    const sch = await db.collection(COL.schedules).where({ projectId, deleted: _.neq(true) }).orderBy('date', 'asc').limit(200).get()
    const maxWin = addDaysBj(30)
    for (const s of (sch.data || [])) {
      if (s.date <= fromDateStr || s.date > maxWin || s.closed) continue
      const sess = (s.sessions || []).filter(x => !x.paused && (x.capacity - (x.booked || 0)) > 0 && !(bjTs(s.date, x.start) < Date.now()))
      if (sess.length) return { date: s.date, times: sess.map(x => `${x.start}-${x.end}`).join('、') }
    }
  } catch (e) { /* ignore */ }
  return null
}

// 某项目的某天是否仍有可约场次（相对日期覆盖前先探一下，避免覆盖到一个不可约的日子）
async function dateHasOpen(projectId, date) {
  if (!projectId || !date) return false
  try {
    const r = await db.collection(COL.schedules).where({ projectId, date }).limit(1).get()
    const s = (r.data || [])[0]
    if (!s || s.closed) return false
    const nowTs = Date.now()
    return (s.sessions || []).some(x => !x.paused
      && (x.capacity - (x.booked || 0)) > 0
      && !(bjTs(date, x.start) < nowTs))
  } catch (e) { return false }
}

// ⭐ 相对日期「后端说了算」兜底（2026-09-23，「今天被认成第二天」第四次复现后的根治）
// 背景：日期函数（ymdBj/parseDate）实测一直是对的，#date 自检每次都正确；
//   但模型仍会把"今天/明天"输出成晚一天的绝对日期 —— 弱模型更信任自己上一轮说过的话，
//   而那些话在历史里被反复重放，于是错误在同一条对话串里自我延续，改 prompt 也压不住。
// 结论：**凡是顾客原话里出现相对表达（今天/明天/后天/周X/N天后），日期一律以后端解析为准**，
//   不再让模型的日期有发言权（仅在后端解析的那天确实可约时才覆盖，避免覆盖成不可约的日子）。
const RELATIVE_DATE_RE = /\d+\s*天\s*后|今\s*[天日儿]|当\s*天|明\s*[天日]|后\s*天|大\s*后\s*天|(周|星期)\s*[一二三四五六日天]/

// ===== 5) 预约解析（真实校验，仅抽取 + 判定，不写库）=====
// 第三参 input：用户本轮原话，用于人数兜底解析。
async function resolveBooking(slots, ctxProjectId, input) {
  const projects = await db.collection(COL.projects).where({ published: true, deleted: _.neq(true) }).get()
  const list = projects.data || []

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

  const maxP = project.maxParty || 2
  let date = parseDate(slots.date)
  // 相对日期以后端解析为准（见 RELATIVE_DATE_RE 处注释）：模型的日期在相对表达面前不可信。
  if (RELATIVE_DATE_RE.test(String(input || ''))) {
    const fromText = parseDate(input)
    if (fromText && fromText !== date && (await dateHasOpen(project._id, fromText))) {
      if (date) console.warn('[aiCore] 日期纠正：模型给 ' + date + '，顾客原话「' + String(input).slice(0, 40) + '」解析为 ' + fromText)
      date = fromText
    }
  }
  if (!date) return { ok: false, message: `好的，您想约「${project.name}」。请问希望哪一天到店呢？（可以说"明天""周六"或具体日期）` }

  // 日期合法性守卫：模型偶尔会自己算出绝对日期并写进 slots.date。若该日期落在过去、
  // 或超出 30 天可约窗口，直接判为无效并给最近可约 —— 避免"系统时间算错"整链传导到落库。
  const today = ymdBj()
  const maxWin = addDaysBj(30)
  if (date < today || date > maxWin) {
    const near = await nearestOpenDays(project._id, today)
    return {
      ok: false,
      notice: `「${project.name}」${date} 不在可预约范围内（可约 ${today} 起 30 天内）。`,
      message: near
        ? `小曜已为您查询到最近可约场次：${near.date}（${near.times}）。您想约哪个时间？`
        : `小曜查了未来 30 天，该项目暂无可约场次。您可以看看其他项目，或稍后再来～`
    }
  }

  const sch = await db.collection(COL.schedules).where({ projectId: project._id, date }).get()
  const sched = (sch.data || [])[0]
  const allSessions = (sched && !sched.closed) ? (sched.sessions || []).filter(x => !x.paused) : []
  if (!allSessions.length) {
    const near = await nearestOpenDays(project._id, date)
    return {
      ok: false,
      notice: `您要求的「${project.name}」在 ${date} 没有可约场次。`,
      message: near
        ? `小曜已为您查询到最近可约场次：${near.date}（${near.times}）。您想约哪个时间？`
        : `小曜查了未来 30 天，该项目暂无可约场次。您可以看看其他项目，或稍后再来～`
    }
  }

  const nowTs = Date.now()
  const openSessions = allSessions.filter(x => isNaN(bjTs(date, x.start)) || bjTs(date, x.start) >= nowTs)

  const parsed = parseTime(slots.time)
  if (!parsed) {
    if (!openSessions.length) {
      const near = await nearestOpenDays(project._id, date)
      if (near) return { ok: false, notice: `您要求的「${project.name}」在 ${date} 没有可约场次。`, message: `小曜已为您查询到最近可约场次：${near.date}（${near.times}）。您想约哪个时间？` }
      return { ok: false, notice: `您要求的「${project.name}」在 ${date} 没有可约场次，且近期也暂无可约。`, message: `可以看看其他项目哦～` }
    }
    return { ok: false, message: `您希望 ${date} 几点到店呢？该日可选场次：${openSessions.map(x => `${x.start}-${x.end}`).join('、')}` }
  }

  let sess = allSessions.find(x => x.start === parsed.hm)
  let note = ''
  if (!sess) {
    let best = null, bestDiff = 1e9
    for (const x of openSessions) {
      const [hh, mm] = x.start.split(':').map(Number)
      const diff = Math.abs(hh * 60 + mm - parsed.min)
      if (diff < bestDiff) { bestDiff = diff; best = x }
    }
    if (best && bestDiff <= 60) {
      sess = best
      note = `已将您说的 ${parsed.hm} 调整到最近场次 ${sess.start}`
    } else {
      const opts = openSessions.map(x => `${x.start}-${x.end}`).join('、')
      return { ok: false, notice: `您要求的「${project.name}」在 ${date} ${parsed.hm} 没有对应场次。`, message: `最近的可用时段：${opts || '（当天已无可约）'}。您选哪个？` }
    }
  }

  if (sess && !isNaN(bjTs(date, sess.start)) && bjTs(date, sess.start) < nowTs) {
    const alt = openSessions.map(x => x.start).join('、')
    return { ok: false, message: `${date} ${sess.start}-${sess.end} 这场已过期，无法预约。${alt ? `您可以选其他时段：${alt}` : '当天已无可约时段，换一天试试？'}` }
  }
  const remaining = (sess.capacity || 0) - (sess.booked || 0)
  if (remaining <= 0) {
    const alt = openSessions.map(x => x.start).join('、')
    return { ok: false, message: `${date} ${sess.start}-${sess.end} 这场已约满，换一场试试？${alt ? `可选：${alt}` : ''}` }
  }

  // 人数：模型漏抽时从用户原话兜底解析。缺失就明确追问，绝不默认 1 人
  // （默认 1 人会静默把 2 人位约成 1 人位，顾客自己改不了，只能重来 —— 真机复现过）。
  const party = parsePartySize(slots.partySize, input)
  if (!party) {
    return {
      ok: false,
      message: `${date} ${sess.start}-${sess.end} 这场可以约。请问一共几位呢？（「${project.name}」单次最多 ${maxP} 人）`
    }
  }

  // 人数钳制：单次上限以项目配置（maxParty）为准，它就是上限本身；再叠加本场剩余名额。
  // ⚠️ 这里**不再返回 ok:false 反复追问**（上一版的行为）：顾客说 5 位而上限 2 位时，
  //   旧逻辑回「需要我按 2 位帮您约，还是拆成两单？」→ 顾客答了又答仍拿不到确认卡，
  //   多轮后还会撞 AI_MAX_ASK_ROUNDS 被推去「常规预约」（真机复现，顾客直接反馈「不满足」）。
  //   正确做法：系统能做到的就是按上限 N 位约成，直接给确认卡，把差额交给人工沟通。
  // 口径：**不提拆单 / 不提分两笔 / 不推回常规预约**，只说明上限 + 给人工出口。
  const capped = Math.max(1, Math.min(party, maxP, Math.max(1, remaining)))
  // ⭐ 上限文案（2026-09-23 定稿，用户指定口径）：
  //   「单次上限 N 人，已按 N 位为您安排；因系统限制，无法单次预约 N 位以上。如您特殊要求，请直接联系店铺 vx / 电话 19292757851」
  //   两个 N 都取自项目配置的 maxParty（不同项目上限不同 ⇒ 必须动态拼接，写死 2 是错的）。
  //   「已按 N 位」用 capped（= min(顾客说的, maxParty, 本场剩余)），剩余名额不足时才不等于上限。
  // 文案要短：这段同时会被塞进公众号卡片的 Description（卡片形态下 AI 原话会被丢弃），
  // 太长会被微信截断显示。所以只保留「上限是多少 → 已按几位安排 → 系统限制 → 人工出口」四件事。
  const capNote = capped < party
    ? `单次上限 ${maxP} 人，已按 ${capped} 位为您安排；因系统限制，无法单次预约 ${maxP} 位以上。如您特殊要求，请直接联系店铺 vx / 电话 ${SHOP_CONTACT}`
    : ''

  return {
    ok: true,
    confirmation: {
      projectId: project._id, projectName: project.name, date,
      sessionId: sess.id, sessionStart: sess.start, sessionEnd: sess.end,
      partySize: capped, note: [note, capNote].filter(Boolean).join('；'),
      // 顾客原话要的人数（未钳制）：确认卡据此提示「您说的 N 位超上限，已按 M 位安排」
      requestedPartySize: party,
      // 必填资料提示：随确认卡下发到前端 / 公众号卡片描述，让顾客在提交前就知道要留什么
      fillNote: FILL_REQUIRED_NOTE
    }
  }
}

// ===== 6) 读取顾客资料（确认卡复用）=====
// 小程序端：直接按 openid 取 users 文档。
// 公众号端：openid 是「公众号 openid」，users 里没有对应文档 —— 改按 unionid 关联查，
//   命中则该顾客在小程序里填过的称呼/手机可直接带出（少填一次表单）。
async function loadProfile(openid, channel, unionid) {
  const empty = { name: '', phone: '' }
  if (!openid) return empty
  if (channel !== 'oa') {
    try {
      const r = await db.collection(COL.users).doc(openid).get()
      const d = r && r.data
      return { name: (d && d.name) || '', phone: (d && d.phone) || '' }
    } catch (e) { return empty }
  }
  // 公众号渠道：优先按 unionid 关联小程序身份
  if (unionid) {
    try {
      const r = await db.collection(COL.users).where({ unionid }).limit(1).get()
      const d = (r.data || [])[0]
      if (d && (d.name || d.phone)) return { name: d.name || '', phone: d.phone || '' }
    } catch (e) { /* 落到下方按公众号 openid 查 */ }
  }
  try {
    const r = await db.collection('oaUsers').doc(openid).get().catch(() => null)
    const d = r && r.data
    return { name: (d && d.name) || '', phone: (d && d.phone) || '' }
  } catch (e) { return empty }
}

// ===== 7) 对话日志落库（aiLogs）=====
// channel：'mp'（小程序）/ 'oa'（公众号），供数据分析做渠道区分与占比。
// ⚠️ CloudBase 不会自动创建集合：aiLogs 缺失时 add 会失败 —— 保留 warn，禁止静默吞。
async function logTurn({ openid, channel, unionid, nickname, input, intent, reply, slots, model, usage, ms }) {
  try {
    const u = usage || {}
    const pt = (u.prompt_tokens != null) ? u.prompt_tokens : (u.promptTokens != null ? u.promptTokens : null)
    const ct = (u.completion_tokens != null) ? u.completion_tokens : (u.completionTokens != null ? u.completionTokens : null)
    const tokens = (pt != null && ct != null) ? (pt + ct)
      : (u.total_tokens != null ? u.total_tokens : (u.totalTokens != null ? u.totalTokens : null))
    let cost = null
    if (pt != null && ct != null) cost = +(pt / 1000 * 0.8 + ct / 1000 * 2).toFixed(4)
    const r = await db.collection('aiLogs').add({
      data: {
        openid: openid || '',
        channel: channel || 'mp',      // mp=小程序 / oa=公众号（历史数据无此字段，统计时按 mp 归口）
        unionid: unionid || '',
        nickname: nickname || '',
        input: input || '',
        output: reply || '',
        intent: intent || 'chat',
        slots: slots || null,
        model: model || '',
        tokens: tokens,
        cost: cost,
        latencyMs: ms || null,
        booked: false,
        reservationId: '',
        createdAt: db.serverDate()
      }
    })
    return (r && r._id) || ''
  } catch (e) {
    console.warn('[aiCore] logTurn failed (ignored):', e && (e.message || e.errMsg || e))
    return ''
  }
}

// ===== 8) 统一入口 =====
// 入参：{ openid, channel:'mp'|'oa', unionid, messages, projectId, nickname, channelExtra }
// 出参：{ intent:'chat'|'ask'|'confirm', reply, notice?, confirmation?, profile?, logId?, limited? }
//   limited===true 表示命中每日轮次上限（此时不会调用 AI、不落 aiLogs）
async function runChat(opts) {
  const o = opts || {}
  const t0 = Date.now()
  const openid = o.openid || ''
  const channel = o.channel === 'oa' ? 'oa' : 'mp'
  const unionid = o.unionid || ''
  const messages = Array.isArray(o.messages) ? o.messages
    .filter(m => m && m.role && typeof m.content === 'string')
    .slice(-20) : []
  const ctxProjectId = o.projectId || ''
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const input = lastUser ? lastUser.content : ''
  const model = (process.env.AI_PROVIDER || 'hunyuan-exp') + '/' + (process.env.AI_MODEL || 'hunyuan-turbos-latest')

  // ① 每日轮次配额（后台 config.ai 配置；0 = 不限）
  // ② 可用性摘要与配额检查之间没有依赖 → 并发启动，压缩首字延迟（公众号被动回复仅 5 秒预算）
  const availP = loadAvailabilityCached().catch(() => '(可用性获取失败)')
  const limits = await loadAiLimits()
  const quota = await checkAiQuota(limits, openid, channel)
  if (!quota.allowed) {
    return {
      intent: 'chat',
      reply: limits.limitReply,
      limited: true,
      quota: { used: quota.used, limit: quota.limit }
    }
  }
  // 通过配额检查后才计数：本轮算一次（无论最终是 chat/ask/confirm）
  await incrAiQuota(openid, channel)

  const availability = await availP
  const sys = buildSystemPrompt(availability, o.channelExtra)
  // 【时间校准锚点 · 2026-09-23】为什么 system prompt 里已有时间还要再注入一条：
  //   弱模型会信任「自己过去说过的话」胜过 system prompt。旧线程里若说过错误日期
  //   （双重平移时期的"系统时间是 09-24"），错误会随历史自我延续 —— 每轮把错误写回
  //   会话记录再被重放，修了代码也治不好旧线程（真机三次复现）。
  //   对策：在历史之后、最新一条用户消息之前，再注入一条强校准 system 消息
  //  （近因位置约束力最强），明确宣布历史中的日期说法一律作废。
  const anchor = [
    '【时间校准 · 最高优先级】',
    `当前北京时间：${ymdBj()} 星期${WD_CN[bjNow().getUTCDay()]} ${String(bjNow().getUTCHours()).padStart(2, '0')}:${String(bjNow().getUTCMinutes()).padStart(2, '0')}。`,
    '上方历史消息（包括你自己之前的回复）中出现的一切日期与「系统时间」说法，只要与本条不一致，一律作废、绝不再引用。',
    `顾客说的「今天」=${ymdBj()}，「明天」=${addDaysBj(1)}，「后天」=${addDaysBj(2)}，「大后天」=${addDaysBj(3)}。`,
    '顾客用相对说法时，slots.date 原样保留相对说法，由系统负责换算，你不要自己计算具体日期。'
  ].join('\n')
  const anchorMsg = { role: 'system', content: anchor }
  let full
  if (messages.length) {
    const lastIdx = messages.length - 1
    full = [{ role: 'system', content: sys },
      ...messages.slice(0, lastIdx), anchorMsg, ...messages.slice(lastIdx)]
  } else {
    full = [{ role: 'system', content: sys }, anchorMsg]
  }

  let aiRes
  try {
    aiRes = await callAI(full)
  } catch (e) {
    // AI 不可用：不落日志（避免污染漏斗），交由调用方降级
    throw e
  }
  const text = aiRes.text
  const usage = aiRes.usage

  const parsed = parseModel(text)
  let out
  if (!parsed || typeof parsed.intent !== 'string') {
    out = { intent: 'chat', reply: (text || '').slice(0, 500) || '抱歉，我没能理解，请再说一遍～' }
  } else if (parsed.intent !== 'book') {
    out = { intent: 'chat', reply: parsed.reply || (text || '').slice(0, 500) || '好的～' }
  } else {
    // ⚠️ 第三个参数 input（用户本轮原话）必须传：人数靠它做确定性兜底解析。
    //    （曾经漏传过，导致「从原话解析人数」这段代码形同虚设 —— 模型说几位就是几位。）
    const res = await resolveBooking(parsed.slots || {}, ctxProjectId, input)
    if (!res.ok) {
      const MAX_ASK_ROUNDS = Number(process.env.AI_MAX_ASK_ROUNDS) || 5
      const userTurns = messages.filter(m => m.role === 'user').length
      if (userTurns > MAX_ASK_ROUNDS) {
        out = { intent: 'chat', reply: `看来我还没完全帮您约上～您可以直接用「常规预约」点选日期与场次，更快更准哦。${shopContactLine()}。` }
      } else {
        out = { intent: 'ask', reply: res.message, notice: res.notice }
      }
    } else {
      const profile = await loadProfile(openid, channel, unionid)
      const c = res.confirmation
      // 必填资料提示放进 reply：顾客在点「确认预约」之前就知道要留称呼 + 手机号，避免提交了才被拦
      const reply = `已为您查到可约时段：「${c.projectName}」${c.date} ${c.sessionStart}-${c.sessionEnd}，${c.partySize} 人位。${c.note ? c.note + '。' : ''}${FILL_REQUIRED_NOTE}。请确认预约信息～`
      out = { intent: 'confirm', reply, confirmation: c, profile }
    }
  }

  const logId = await logTurn({
    openid, channel, unionid, nickname: o.nickname, input,
    intent: out.intent, reply: out.reply,
    slots: parsed && parsed.slots, model, usage, ms: Date.now() - t0
  }).catch(() => '')
  if (logId) out.logId = logId
  return out
}

module.exports = {
  runChat, loadAvailability, loadAvailabilityCached, resolveBooking, logTurn, loadProfile,
  // 供诊断命令（mpChatHttp 的 #date）与测试复用：日期/人数解析是踩过坑的地方，需要可外部验证
  ymdBj, addDaysBj, parseDate, parseTime, parsePartySize, buildSystemPrompt,
  FILL_REQUIRED_NOTE
}
