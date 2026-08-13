const { call } = require('../../utils/cloud')

const MAP = {
  pending: ['待审核', 'paused'],
  confirmed: ['预约成功', 'ok'],
  completed: ['已完成', 'done'],
  cancelled: ['已取消', 'full'],
  expired: ['已过期', 'expired']
}

Page({
  data: { list: [] },

  onShow() { this.load() },

  load() {
    call('listMyReservations')
      .then(d => {
        const list = (d.list || []).map(r => ({
          ...r,
          statusText: (MAP[r.status] || ['', ''])[0],
          statusClass: (MAP[r.status] || ['', ''])[1]
        }))
        this.setData({ list })
      })
      .catch(e => wx.showToast({ title: e.message || '加载失败', icon: 'none' }))
  },

  cancel(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '取消预约',
      content: '确定要取消该预约吗？取消后名额将释放。',
      confirmText: '确认取消', cancelText: '再想想',
      success: r => {
        if (!r.confirm) return
        wx.showLoading({ title: '取消中' })
        call('cancelReservation', { reservationId: id })
          .then(() => { wx.hideLoading(); wx.showToast({ title: '已取消', icon: 'success' }); this.load() })
          .catch(e => { wx.hideLoading(); wx.showToast({ title: e.message || '取消失败', icon: 'none' }) })
      }
    })
  }
})
