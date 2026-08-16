Component({
  properties: {
    openDays: { type: Array, value: [] },
    selected: { type: Array, value: [] },
    year: { type: Number, value: 2026 },
    month: { type: Number, value: 8 }
  },
  data: { cells: [], WEEK: ['日', '一', '二', '三', '四', '五', '六'] },
  lifetimes: {
    attached() { this.build() }
  },
  observers: { 'year,month,openDays,selected': function () { this.build() } },
  methods: {
    build() {
      const y = this.data.year, m = this.data.month
      const first = new Date(y, m - 1, 1).getDay()
      const days = new Date(y, m, 0).getDate()
      const now = new Date()
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const cells = []
      for (let i = 0; i < first; i++) cells.push({ empty: true })
      for (let d = 1; d <= days; d++) {
        const ymd = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        cells.push({ empty: false, ymd, day: d, open: this.data.openDays.indexOf(ymd) >= 0, sel: this.data.selected.indexOf(ymd) >= 0, today: ymd === todayStr })
      }
      this.setData({ cells })
    },
    prev() {
      const y = this.data.year, m = this.data.month
      const ny = m === 1 ? y - 1 : y, nm = m === 1 ? 12 : m - 1
      this.setData({ year: ny, month: nm })
    },
    next() {
      const y = this.data.year, m = this.data.month
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1
      this.setData({ year: ny, month: nm })
    },
    tap(e) {
      const ymd = e.currentTarget.dataset.ymd
      if (!ymd) return
      this.triggerEvent('select', { ymd })
    }
  }
})
