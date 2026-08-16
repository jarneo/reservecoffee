// getSmsConfig — 读取短信全局配置（owner）
// 出于安全，不回显密钥明文，仅返回掩码与是否已配置标记。
const { db, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async () => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可查看')

  const doc = await db.collection('config_sms').doc('sms').get().catch(() => ({ data: null }))
  const c = doc.data || {}
  return ok({
    config: {
      signName: c.signName || '',
      templateId: c.templateId || '',
      smsSdkAppId: c.smsSdkAppId || '',
      secretIdMask: c.secretId ? c.secretId.slice(0, 4) + '****' : '',
      hasSecret: !!c.secretKey,
      noticeTemplate: c.noticeTemplate || ''
    }
  })
}
