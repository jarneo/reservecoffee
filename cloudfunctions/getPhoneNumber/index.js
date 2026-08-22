// getPhoneNumber — 用 getPhoneNumber 按钮返回的 code 换取真实手机号
// 走云开发「内部可信通道」cloud.openapi.phonenumber.getPhoneNumber：
//   · 不碰 HTTP 网关，不被出网白名单拦截（直连 api.weixin.qq.com 才会 412）
//   · 不需 AppSecret / access_token，免费环境即可
// 前提：小程序须为「非个人主体」（企业/个体工商户等完成认证），否则微信持续报错。
const { cloud, ok, fail } = require('./lib')

// 调试桩：code 以 debug_ 开头时直接返回后面的号码，跳过微信可信通道（手动联调用）。
// 真实微信 code 不会以 debug_ 开头，不受影响。保留作服务端测试安全网。
function debugPhone(code) {
  if (code && code.indexOf('debug_') === 0) {
    const p = code.slice('debug_'.length)
    if (/^\d{6,20}$/.test(p)) return p
  }
  return null
}

exports.main = async (event) => {
  const { code } = event
  if (!code) return fail('缺少 code')
  // 调试桩：联调 / 真机无码时手动触发
  const dp = debugPhone(code)
  if (dp) return ok({ phone: dp, debug: true })
  // 真实路径：云开发内部可信通道解密手机号（无需出网、无需密钥）
  try {
    const res = await cloud.openapi.phonenumber.getPhoneNumber({ code })
    const phone = res && res.phoneInfo && res.phoneInfo.phoneNumber
    if (!phone) return fail('未获取到手机号')
    return ok({ phone })
  } catch (e) {
    return fail(e.message || '获取手机号失败')
  }
}
