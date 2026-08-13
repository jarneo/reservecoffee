Component({
  properties: {
    session: { type: Object, value: {} },
    canChangeCap: { type: Boolean, value: false },
    showCancel: { type: Boolean, value: false }
  },
  methods: {
    onPause() { this.triggerEvent('op', { action: 'pause', id: this.data.session.id }) },
    onResume() { this.triggerEvent('op', { action: 'resume', id: this.data.session.id }) },
    onCap() { this.triggerEvent('op', { action: 'changeCap', id: this.data.session.id }) },
    onCancel() { this.triggerEvent('op', { action: 'cancelAll', id: this.data.session.id }) }
  }
})
