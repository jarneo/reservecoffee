// createProject — 新建预约项目（仅 owner）
const { db, COL, ok, fail, wxCtx, getRole } = require('./lib')

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  const role = await getRole(OPENID)
  if (role.role !== 'owner') return fail('仅超级管理员可新建项目')

  const name = (event.name || '').trim()
  if (!name) return fail('请填写项目名称')

  let adv = Number(event.advanceDays) || 7
  if (!(adv >= 1 && adv <= 30)) return fail('提前天数须在 1–30 之间')

  const dayLimit = Math.max(1, Number(event.dailyLimit) || 1)
  const useSlotTemplate = !!event.useSlotTemplate
  const slotTemplate = Array.isArray(event.slotTemplate) ? event.slotTemplate.slice(0, 20) : []

  const doc = {
    name,
    icon: event.icon || '',
    iconFileId: event.iconFileId || '',
    image: event.image || '',
    intro: (event.intro || '').toString().slice(0, 300),
    published: false,
    needReview: !!event.needReview,
    dailyLimit: dayLimit,
    advanceDays: adv,
    useSlotTemplate,
    slotTemplate,
    paused: false,
    maxParty: 2,
    subscribeNotify: true,
    showSeatInfo: true,
    openDays: [],
    // 通知管理员分配：默认全体管理员可接收本项目通知（与现状一致、零丢单）；店主随后可在矩阵里收窄。
    // 采用项目维度存储，新增项目天然全员，避免「白名单模型下新项目漏通知被收窄管理员」的坑。
    notifyAdmins: 'all',
    ownerOpenid: OPENID,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  const add = await db.collection(COL.projects).add({ data: doc })
  return ok({ id: add._id })
}
