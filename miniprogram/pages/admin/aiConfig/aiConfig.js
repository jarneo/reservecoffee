const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

const MAX = 6

Page({
  behaviors: [guard],
  data: {
    enabled: true,
    saving: false,
    quick: [],
    // 公众号 AI 助理（客服消息）
    oaEnabled: true,
    cardThumbMediaId: '',
    // 每用户每日对话轮次上限（0 = 不限）
    dailyTurnLimit: '30',
    oaDailyTurnLimit: '',      // 空 = 沿用上方
    limitReply: ''
  },

  onLoad() {
    this.guard(['owner']).then(role => {
      if (!role) return
      call('getAiConfig').then(d => {
        this.setData({
          enabled: d.enabled !== false,
          oaEnabled: d.oaEnabled !== false,
          cardThumbMediaId: d.cardThumbMediaId || '',
          dailyTurnLimit: String(d.dailyTurnLimit == null ? 30 : d.dailyTurnLimit),
          // 未单独设置时返回 ''，输入框留空表示「沿用上方」
          oaDailyTurnLimit: (d.oaDailyTurnLimit === '' || d.oaDailyTurnLimit == null) ? '' : String(d.oaDailyTurnLimit),
          limitReply: d.limitReply || '',
          quick: (d.quickReplies || []).map((x, i) => ({ _i: i, label: x.label || '', text: x.text || '' }))
        })
      }).catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
    })
  },

  toggle(e) { this.setData({ enabled: !!e.detail.value }) },
  toggleOa(e) { this.setData({ oaEnabled: !!e.detail.value }) },

  // 数字型输入直接 setData 回写（数字不涉及中文输入法光标跳动问题，回写可避免列表变动时被旧值覆盖）
  onDailyLimit(e) { this.setData({ dailyTurnLimit: e.detail.value }) },
  onOaDailyLimit(e) { this.setData({ oaDailyTurnLimit: e.detail.value }) },
  onLimitReply(e) { this.setData({ limitReply: e.detail.value }) },
  onThumb(e) { this.setData({ cardThumbMediaId: e.detail.value }) },

  // 只改数据模型、不回写 value：避免每次输入都 setData 导致中文输入法下光标跳动 / 内容被截断。
  // 列表本身（增删/排序）走 reindex 时统一 setData，输入值不会被丢。
  onLabel(e) {
    const i = +e.currentTarget.dataset.i
    if (this.data.quick[i]) this.data.quick[i].label = e.detail.value
  },
  onText(e) {
    const i = +e.currentTarget.dataset.i
    if (this.data.quick[i]) this.data.quick[i].text = e.detail.value
  },

  addQuick() {
    const q = this.data.quick.slice()
    if (q.length >= MAX) return
    q.push({ _i: q.length, label: '', text: '' })
    this.setData({ quick: this.reindex(q) })
  },
  rmQuick(e) {
    const q = this.data.quick.slice()
    q.splice(+e.currentTarget.dataset.i, 1)
    this.setData({ quick: this.reindex(q) })
  },
  moveUp(e) {
    const i = +e.currentTarget.dataset.i
    if (i <= 0) return
    const q = this.data.quick.slice()
    const t = q[i]; q[i] = q[i - 1]; q[i - 1] = t
    this.setData({ quick: this.reindex(q) })
  },
  moveDown(e) {
    const i = +e.currentTarget.dataset.i
    const q = this.data.quick.slice()
    if (i >= q.length - 1) return
    const t = q[i]; q[i] = q[i + 1]; q[i + 1] = t
    this.setData({ quick: this.reindex(q) })
  },
  // 增删/换位后重排 _i（wx:key 依赖它，避免列表复用错位）
  reindex(list) { return list.map((x, i) => ({ _i: i, label: x.label || '', text: x.text || '' })) },

  save() {
    if (this.data.saving) return
    const q = this.data.quick
    for (let i = 0; i < q.length; i++) {
      const label = (q[i].label || '').trim()
      const text = (q[i].text || '').trim()
      if (!label || !text) {
        wx.showToast({ title: '第 ' + (i + 1) + ' 条未填写完整', icon: 'none' })
        return
      }
    }
    // 轮次上限校验：必须是 0–999 的整数，空表示未设置
    const numOrNull = (v) => {
      const s = String(v == null ? '' : v).trim()
      if (s === '') return null
      const n = Number(s)
      if (!isFinite(n) || n < 0 || n > 999) return NaN
      return Math.floor(n)
    }
    const daily = numOrNull(this.data.dailyTurnLimit)
    const oaDaily = numOrNull(this.data.oaDailyTurnLimit)
    if (daily !== daily || oaDaily !== oaDaily) {
      wx.showToast({ title: '轮次上限需为 0–999 的整数', icon: 'none' })
      return
    }

    this.data.saving = true
    wx.showLoading({ title: '保存中' })
    call('saveAiConfig', {
      enabled: this.data.enabled,
      quickReplies: q.map(x => ({ label: (x.label || '').trim(), text: (x.text || '').trim() })),
      greeting: (this.data.greeting || '').trim(),
      oaEnabled: this.data.oaEnabled,
      dailyTurnLimit: daily == null ? 30 : daily,
      // 传 null 表示「沿用上方」：云端会清掉该字段
      oaDailyTurnLimit: oaDaily,
      limitReply: (this.data.limitReply || '').trim(),
      cardThumbMediaId: (this.data.cardThumbMediaId || '').trim()
    })
      .then(() => { wx.hideLoading(); wx.showToast({ title: '已保存', icon: 'success' }); this.data.saving = false })
      .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '保存失败', icon: 'none' }); this.data.saving = false })
  }
})
