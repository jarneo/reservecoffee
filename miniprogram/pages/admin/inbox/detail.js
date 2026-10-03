const { call } = require('../../../utils/cloud')
const guard = require('../../../components/adminGuard/adminGuard.js')

const p2 = n => String(n).padStart(2, '0')

function fmtFull(ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts))
  if (isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

// 「5 → ★★★★★」。WXML 不能调 JS，星级必须在这里算好
function stars(n) {
  const c = Math.max(0, Math.min(5, Math.round(Number(n) || 0)))
  return '★'.repeat(c) + '☆'.repeat(5 - c)
}

// 四类通知的标题 / 主按钮 / 次按钮。
// ⚠️ 主按钮统一走 goMain + data-a，不用 `bindtap="{{xxx}}"` 动态事件名（可读性差且易出错）。
const MAIN = {
  reviewRes: { text: '去审核 ›', act: 'goReview' },
  reviewDish: { text: '去评价管理 ›', act: 'goReviewDish' }
}

Page({
  behaviors: [guard],
  data: {
    id: '',
    title: '通知详情',
    rows: [],       // [{k, v}] —— WXML 不能调 JS，展示行一律预计算
    phone: '',
    projectId: '',
    date: '',
    mainText: '',   // 主按钮文案；空则不渲染
    mainAction: '', // 主按钮动作标识（goMain 里分发）
    subText: '',    // 次按钮文案（仅「预约审核」有：查看该预约）
    subAction: '',
    loading: true
  },
  onLoad(q) {
    const id = (q && q.id) || ''
    this.setData({ id })
    this.guard(['owner', 'manager']).then(role => { if (role) this.load() })
  },
  async load() {
    let d
    try {
      d = await call('getInbox', { id: this.data.id })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
      return
    }
    const it = d && d.item
    if (!it) {
      this.setData({ loading: false })
      wx.showToast({ title: '通知不存在或已删除', icon: 'none' })
      return
    }

    const type = it.type || 'new'
    const isCancel = type === 'cancel'
    const isReview = type === 'reviewRes'
    const isDish = type === 'reviewDish'

    let title, rows
    if (isDish) {
      title = '评论审核'
      rows = [
        { k: '菜品', v: it.productName || '—' },
        { k: '所属项目', v: it.projectName || '—' },
        { k: '评分', v: stars(it.rating) + ' ' + (Number(it.rating) || 0).toFixed(1) },
        { k: '评价人', v: it.customerName || '—' },
        { k: '评价内容', v: it.text || '—' },
        // 只给张数：图片是云存储 fileID，换临时链接要额外一次请求；
        // 「去评价管理」页已经会解析并展示原图，详情页不重复实现（也更省流量）。
        { k: '图片', v: it.imageCount ? it.imageCount + ' 张（去评价管理页查看）' : '无' },
        { k: '审核状态', v: '待审核（暂不对外展示、不计入评分）' },
        { k: '提交时间', v: fmtFull(it.createdAt) }
      ]
    } else {
      title = isCancel ? '取消预约' : (isReview ? '预约审核' : '新预约')
      rows = [
        { k: '项目', v: it.projectName || '—' },
        { k: '日期', v: it.date || '—' },
        { k: '场次', v: (it.sessionStart && it.sessionEnd) ? it.sessionStart + ' - ' + it.sessionEnd : '—' },
        { k: '预订人', v: it.customerName || '—' },
        { k: '人数', v: (it.count || 1) + ' 人' },
        { k: '手机号', v: it.phone || '—' },
        { k: '备注', v: it.note || '—' }
      ]
      // 预约审核把「操作方」换成「审核状态」—— 它最有用的信息是「还没定，名额暂被占着」
      rows.push(isReview
        ? { k: '审核状态', v: '待审核（名额已暂时占用，通过后转为确认）' }
        : { k: '操作方', v: isCancel ? (it.byAdmin ? '管理员取消' : '顾客取消') : '顾客下单' })
      // ⚠️ 文案由「到达时间」改为「提交时间」：该字段实际是 createdAt（下单/取消那一刻），
      //    「到达」容易被误读成到店时间
      rows.push({ k: '提交时间', v: fmtFull(it.createdAt) })
    }

    const m = MAIN[type] || null
    this.setData({
      loading: false,
      title,
      rows,
      phone: it.phone || '',
      projectId: it.projectId || '',
      date: it.date || '',
      mainText: m ? m.text : '查看该预约',
      mainAction: m ? m.act : 'gotoRes',
      // 「预约审核」额外给一个次按钮，保留原有「查看该预约」的能力
      subText: isReview ? '查看该预约' : '',
      subAction: 'gotoRes'
    })
    // 打开详情即视为已读（按人独立）。失败静默——不影响查看，最多红点不消失
    call('markInboxRead', { id: it._id }).catch(() => {})
  },
  // 主 / 次按钮统一入口（data-a 分发）
  goMain(e) {
    const a = e.currentTarget.dataset.a
    if (a === 'gotoRes') return this.gotoRes()
    if (a === 'goReview') return wx.navigateTo({ url: '/pages/admin/review/review' })
    if (a === 'goReviewDish') return wx.navigateTo({ url: '/pages/admin/reviewAdmin/reviewAdmin' })
  },
  callPhone() {
    const p = this.data.phone
    if (!p) { wx.showToast({ title: '无手机号', icon: 'none' }); return }
    wx.makePhoneCall({ phoneNumber: p, fail: () => {} })
  },
  copyPhone() {
    const p = this.data.phone
    if (!p) { wx.showToast({ title: '无手机号', icon: 'none' }); return }
    wx.setClipboardData({ data: p })
  },
  // 跳「预约管理」页并定位到该项目 + 日期（复用 view 页已有的 projectId/date 入参）
  gotoRes() {
    const { projectId, date } = this.data
    if (!projectId) { wx.showToast({ title: '缺少项目信息', icon: 'none' }); return }
    wx.navigateTo({ url: `/pages/admin/view/view?projectId=${projectId}&date=${date}` })
  },
  back() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.redirectTo({ url: '/pages/admin/inbox/inbox' })
  }
})
