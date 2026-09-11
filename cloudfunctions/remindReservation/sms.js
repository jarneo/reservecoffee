// cloudfunctions/_lib/sms.js — 腾讯云短信发送辅助（多模板，无参数模板）
// 依赖：tencentcloud-sdk-nodejs-sms（在调用方云函数的 package.json 中声明）
// 合规说明：国内短信必须使用控制台「已审批」的签名 + 模板。
// 注意：本项目的业务模板均为「无参数模板」（除验证码模板外均不支持参数配置），故发送时不传 TemplateParamSet。
// 模板键 → 场景：success 预定成功(2715328) / approaching 预约临近(2716156) / expired 预约过期(2716682)
//                cancel 取消通知(2729679) / dayBefore 提前一天通知(2729722)
// 店铺名由控制台签名 SignName 提供（=「二曜路8号咖啡和清酒」），模板正文不含签名前缀。

const REGION = process.env.SMS_REGION || 'ap-guangzhou'

// 读取短信全局配置：优先环境变量，回退 config_sms 文档（_id:'sms'）
// 返回：{ secretId, secretKey, smsSdkAppId, signName, region,
//        templates:{success, approaching, expired, cancel, dayBefore} }
async function loadConfig(db) {
  const env = {
    secretId: process.env.SMS_SECRET_ID,
    secretKey: process.env.SMS_SECRET_KEY,
    smsSdkAppId: process.env.SMS_SDK_APP_ID,
    signName: process.env.SMS_SIGN_NAME,
    region: process.env.SMS_REGION
  }
  const hasEnv = env.secretId && env.secretKey && env.smsSdkAppId && env.signName
  if (hasEnv) {
    // 环境变量仅支持单模板(SMS_TEMPLATE_ID) 的兼容回退：各场景复用同一模板
    const t = process.env.SMS_TEMPLATE_ID
    return {
      ...env,
      region: env.region || REGION,
      templates: { success: t, approaching: t, expired: t, cancel: t, dayBefore: t }
    }
  }
  const doc = await db.collection('config_sms').doc('sms').get().catch(() => ({ data: null }))
  const c = doc && doc.data ? doc.data : null
  if (!c) return null
  return {
    secretId: c.secretId,
    secretKey: c.secretKey,
    smsSdkAppId: c.smsSdkAppId,
    signName: c.signName,
    region: c.region || REGION,
    templates: c.templates || {}
  }
}

/**
 * 发送指定模板的短信（无参数模板）
 * @param {object} o { db, phone, templateId }
 *   templateId：腾讯云控制台已审批的模板 ID（字符串/数字均可）
 * 说明：三个业务模板均为无参数模板，故 TemplateParamSet 恒为空数组。
 */
async function sendTemplateSms(o) {
  const { db, phone, templateId } = o
  if (!phone) return { skipped: true, reason: 'no phone' }
  if (!templateId) return { skipped: true, reason: 'no templateId' }

  const cfg = await loadConfig(db)
  if (!cfg || !cfg.secretId) return { skipped: true, reason: 'sms not configured' }

  let SmsClient
  try {
    SmsClient = require('tencentcloud-sdk-nodejs-sms').sms.v20210111.Client
  } catch (e) {
    console.warn('[sms] SDK not installed, skip:', e.message)
    return { skipped: true, reason: 'sdk missing' }
  }

  const client = new SmsClient({
    credential: { secretId: cfg.secretId, secretKey: cfg.secretKey },
    // ⚠️ 腾讯云短信 SendSms API 仅支持 ap-guangzhou 这一个 API 地域；
    // 真实发送地域由 SmsSdkAppId 决定。配置里若误填 region（如 ap-shanghai）
    // 会触发 "The action does not support this region." 使全部短信静默失败。
    // 故此处固定使用 REGION（=ap-guangzhou），忽略 config_sms 里的 region 字段。
    region: REGION,
    profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } }
  })

  try {
    const res = await client.SendSms({
      PhoneNumberSet: ['+86' + phone],
      SmsSdkAppId: cfg.smsSdkAppId,
      SignName: cfg.signName,
      TemplateId: String(templateId),
      TemplateParamSet: []
    })
    const set = (res && res.SendStatusSet) || []
    // 腾讯云短信：每条发送结果 Code==='Ok' 才成功；平台级拒收（单号日上限 / 模板未审批 / 签名不符等）
    // 不会抛异常，只会在 SendStatusSet 里返回非 Ok 的 Code + Message。必须显式检查，否则会被误判为成功。
    const failed = set.filter(s => s.Code !== 'Ok')
    if (failed.length) {
      const msg = failed.map(s => `${s.SerialNo || ''}:${s.Code}:${s.Message}`).join('; ')
      console.warn('[sms] send rejected:', templateId, msg)
      return { ok: false, error: msg, detail: set }
    }
    console.log('[sms] sent ok', templateId, set)
    return { ok: true, res }
  } catch (e) {
    console.warn('[sms] send failed (ignored):', e.message)
    return { ok: false, error: e.message }
  }
}

/**
 * 发送「预定成功」短信（兼容旧调用）：使用 success 模板（无参数）
 * @param {object} o { db, phone }
 */
async function sendReservationSms(o) {
  const { db, phone } = o
  const cfg = await loadConfig(db)
  if (!cfg) return { skipped: true, reason: 'sms not configured' }
  const tid = cfg.templates && cfg.templates.success
  if (!tid) return { skipped: true, reason: 'no success template' }
  return sendTemplateSms({ db, phone, templateId: tid })
}

module.exports = { sendReservationSms, sendTemplateSms, loadConfig }
