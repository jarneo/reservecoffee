// components/categoryTabs — 首页/菜单页顶部「分类切换栏」
// 横滑 tab：首项固定「全部」(activeId='all')，其后为各类目；选中态品牌色 + 底部短下划线。
// 切换时 triggerEvent('change', { id })，id='all' 表示全部。
Component({
  properties: {
    categories: { type: Array, value: [] },   // [{_id, name}]
    activeId: { type: String, value: 'all' }   // 'all' 或某 categoryId
  },
  methods: {
    onTap(e) {
      const id = e.currentTarget.dataset.id
      if (id === this.data.activeId) return
      this.triggerEvent('change', { id })
    }
  }
})
