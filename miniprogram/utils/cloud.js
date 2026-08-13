// utils/cloud.js — 统一的云函数调用封装
function call(name, data = {}) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: res => {
        const result = res.result || {}
        if (result.code === 0 || result.code === undefined) {
          resolve(result.data !== undefined ? result.data : result)
        } else {
          reject(new Error(result.message || '请求失败'))
        }
      },
      fail: err => reject(err)
    })
  })
}

module.exports = { call }
