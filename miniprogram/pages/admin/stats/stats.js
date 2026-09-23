// pages/admin/stats/stats — 数据分析看板（超级管理员）
// 板块1 总览 / 板块2 转化漏斗（埋点后 4 层真实）/ 板块3 用户分层 / 板块4 项目维度
//      / 板块5 时间趋势 / 板块6 预约时段 / 板块7 提前预约 / 板块9 用户维度·项目交叉
// ⚠️ 板块8「场次时长分析」已按需求移除。
// ⚠️ WXML 禁 JS 调用：所有百分比 / 宽度 / 分组一律在此预计算后再 setData。
const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

function buildView(d) {
  const k = d.kpi

  // ===== 板块1 总览（6 个 KPI → 2 列 3 行） =====
  const kpis = [
    { l: '访问UV', n: k.visitUV },
    { l: '成功预约UV', n: k.uv },
    { l: '总预约单数', n: k.orders },
    { l: '总到店人数', n: k.totalPeople },
    { l: '人均预约次数', n: k.perCap },
    { l: '整体转化率', n: d.funnelRate.overall + '%' }
  ]

  // ===== 板块2 漏斗（4 层真实数据，宽度按最高层归一） =====
  const funnel = d.funnel.map(f => ({ key: f.key, label: f.label, uv: f.uv, pct: f.pct }))

  // ===== 板块3 用户分层（含「只看不约」，埋点后已是真实值） =====
  const t = d.tiers
  const tmax = Math.max(t.t1, t.t2, t.t3, t.t0, 1)
  const tiers = [
    { l: '预约1次', v: t.t1, pct: Math.round(t.t1 / tmax * 100) },
    { l: '预约2次', v: t.t2, pct: Math.round(t.t2 / tmax * 100) },
    { l: '预约≥3次', v: t.t3, pct: Math.round(t.t3 / tmax * 100) },
    { l: '0次(只看不约)', v: t.t0, pct: Math.round(t.t0 / tmax * 100) }
  ]

  // ===== 板块4 项目维度 =====
  const pjMax = Math.max(...d.byProject.map(p => p.cnt), 1)
  const byProject = d.byProject.map(p => ({
    projectId: p.projectId,
    name: p.name,
    cnt: p.cnt,
    ratio: p.ratio,
    uv: p.uv,
    pct: Math.round(p.cnt / pjMax * 100),
    perCap: p.perCap,
    avgLead: p.avgLeadDays,
    submitPeak: p.submitPeakHour < 0 ? '—' : p.submitPeakHour + ':00',
    sessionPeak: p.sessionPeakHour < 0 ? '—' : p.sessionPeakHour + ':00'
  }))

  // ===== 板块5 时间趋势（CSS 分组柱：深=单数 棕=UV） =====
  const trend = d.trend || []
  const ordMax = Math.max(...trend.map(x => x.cnt), 1)
  const uvMax = Math.max(...trend.map(x => x.uv), 1)
  const trendBars = trend.map((x, i) => ({
    id: i,
    cnt: x.cnt, uv: x.uv,
    cntPct: Math.round(x.cnt / ordMax * 100),
    uvPct: Math.round(x.uv / uvMax * 100)
  }))

  // ===== 板块6 时段（24 柱，仅提交时段） =====
  function bars(arr) {
    const max = Math.max(...arr, 1)
    return arr.map((v, i) => ({ h: i, pct: Math.round(v / max * 100), alt: (i >= 18 || i <= 1) }))
  }
  const submitHourBars = bars(d.submitHour)
  const submitPeak = d.submitPeakHour < 0 ? '—' : d.submitPeakHour + ':00'

  // ===== 板块7 提前预约 =====
  const lmax = Math.max(...d.leadDist.map(x => x.cnt), 1)
  const leadBars = d.leadDist.map(x => ({ l: x.label, v: x.cnt, pct: Math.round(x.cnt / lmax * 100) }))

  // ===== 板块9 用户维度 · 项目交叉分析 =====
  const cx = d.cross || { reach: [], combos: [], pairs: [], multi: { uv: 0, pct: 0 } }
  // pct = 柱宽（相对该组最大值）；pctText = 真实占比（相对总 UV）
  const barsOf = (arr, max) => arr.map((x, i) => ({
    id: i, l: x.label, v: x.uv,
    pct: Math.round(x.uv / (max || 1) * 100),
    pctText: x.pct
  }))
  const crossReach = barsOf(cx.reach, Math.max(...cx.reach.map(x => x.uv), 1))
  const crossCombos = barsOf(cx.combos, Math.max(...cx.combos.map(x => x.uv), 1))
  const crossPairs = barsOf(cx.pairs, Math.max(...cx.pairs.map(x => x.uv), 1))

  // ===== 板块 AI 预约对话（含三层漏斗：沟通 → 确认 → 预约成功） =====
  const a = d.ai || {}
  const ai = {
    turns: a.turns || 0,
    users: a.users || 0,
    perCap: a.perCap || 0,
    chat: a.chat || 0,
    ask: a.ask || 0,
    confirm: a.confirm || 0,
    booked: a.booked || 0,
    confirmRate: a.confirmRate || 0,
    bookedRate: a.bookedRate || 0,
    tokens: a.tokens || 0,
    cost: a.cost != null ? a.cost : 0,
    latencyMs: a.latencyMs || 0,
    // 漏斗三层（人数口径，宽度已按首层归一）+ 两级转化率
    funnel: (a.funnel || []).map(f => ({ key: f.key, label: f.label, uv: f.uv, pct: f.pct })),
    rate: a.rate || { talkToConfirm: 0, confirmToBooked: 0, overall: 0 },
    // 来源渠道拆分：mp=小程序端 AI / oa=公众号端 AI（含各自轮次·人数·确认·成单与占比）
    byChannel: {
      mp: (a.byChannel && a.byChannel.mp) || { turns: 0, users: 0, confirm: 0, booked: 0 },
      oa: (a.byChannel && a.byChannel.oa) || { turns: 0, users: 0, confirm: 0, booked: 0 },
      pct: (a.byChannel && a.byChannel.pct) || { mpTurns: 0, oaTurns: 0, mpUsers: 0, oaUsers: 0 }
    },
    // AI 带来的预约单来源拆分（reservations.source）
    orders: a.orders || { ai: 0, oa: 0, total: 0 }
  }

  // ===== 板块 通知触达（订阅通知 / 短信通知）=====
  // 数据源 notifyLogs（云函数在每次真正尝试发送后写一条流水），口径与其它板块同一套 from/to。
  const n = d.notify || { wx: 0, sms: 0, wxOk: 0, smsOk: 0, total: 0, ok: 0, scenes: [] }
  const notify = {
    wx: n.wx || 0,
    sms: n.sms || 0,
    total: n.total || 0,
    ok: n.ok || 0,
    fail: Math.max(0, (n.total || 0) - (n.ok || 0)),
    succRate: n.total ? +((n.ok / n.total) * 100).toFixed(1) : 0,
    wxOk: n.wxOk || 0,
    smsOk: n.smsOk || 0,
    scenes: (n.scenes || []).map((s, i) => ({
      id: i, key: s.key, label: s.label, v: s.n, ok: s.ok, wx: s.wx, sms: s.sms, pct: s.pct
    }))
  }

  return {
    kpis, funnel, funnelRate: d.funnelRate, tiers, byProject,
    ai, notify,
    hasTrend: trend.length > 0, trendBars,
    submitHourBars, submitPeak,
    leadBars,
    avgLeadDays: d.avgLeadDays,
    leadTmp: d.leadRatio.temporary, leadPln: d.leadRatio.planned,
    crossReach, crossCombos, crossPairs,
    crossMulti: cx.multi,
    newUserPct: k.newUserPct,
    totalUv: k.uv
  }
}

Page({
  behaviors: [guard],
  data: {
    role: 'none',
    period: '30',
    loading: false,
    view: null,   // 由 buildView 预计算后的看板数据
    err: ''
  },
  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      this.setData({ role })
      this.load(this.data.period)
    })
  },
  onPullDownRefresh() {
    this.load(this.data.period).then(() => wx.stopPullDownRefresh())
  },
  async load(period) {
    if (this.data.loading) return
    this.setData({ loading: true, period, err: '' })
    try {
      const d = await call('getAnalytics', { period })
      this.setData({ view: buildView(d) })
    } catch (e) {
      this.setData({ err: (e && e.message) || '加载失败' })
      wx.showToast({ title: '分析加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },
  setPeriod(e) {
    const p = e.currentTarget.dataset.p
    if (p === this.data.period) return
    this.load(p)
  }
})
