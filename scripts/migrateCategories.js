// scripts/migrateCategories.js — 存量菜品自动预归类 → 对照表 → 写入
//
// 用法（需在可访问 CloudBase 的环境运行，例如本地装了 wx-server-sdk 并配置 env）：
//   node scripts/migrateCategories.js dump    # 1) 确保 5 个默认类目存在 2) 按关键词预测每道菜类目 3) 输出对照表
//   node scripts/migrateCategories.js apply   # 读取对照表，把 categoryId 写回 products（仅写被确认的条目）
//
// ⚠️ 安全机制：dump 只产出文件，绝不改库；apply 读取 scripts/category-mapping.json，
//   逐条把 mapping[i].categoryId 写回 products[i]._id。任何条目想改类目，直接编辑 JSON 再 apply。
// ⚠️ 类目集合名与字段必须与线上一致：menuCategories / products.categoryId。

const cloud = require('wx-server-sdk')
const fs = require('fs')
const path = require('path')

const ENV = process.env.CLOUDBASE_ENV || 'cloud1-d8g9mhgxm32d2eac6'
cloud.init({ env: ENV })
const db = cloud.database()
const _ = db.command

const COL = { products: 'products', categories: 'menuCategories' }
const MAPPING = path.join(__dirname, 'category-mapping.json')
const MAPPING_MD = path.join(__dirname, 'category-mapping.md')

// 默认类目（sort 越小越靠前）；首次 dump 若缺失则自动创建
const DEFAULT_CATS = [
  { name: '自家煎焙', sort: 10 },
  { name: '经典名店', sort: 20 },
  { name: '特调', sort: 30 },
  { name: '甜品', sort: 40 },
  { name: '清酒', sort: 50 }
]

// 关键词 → 类目（按数组顺序优先匹配；命中即停）
const RULES = [
  { cat: '清酒', kw: ['清酒', '酒', '吟酿', '纯米', '本酿造', '烧酎', '梅酒', 'highball', '嗨棒'] },
  { cat: '甜品', kw: ['甜品', '甜点', '蛋糕', '提拉米苏', '巴斯克', '可颂', '曲奇', '挞', '面包', '布丁', '慕斯'] },
  { cat: '特调', kw: ['特调', '桂花', '海盐', '西柚', '柚子', '风味', '气泡', '苏打', '姜', '椰', '薄荷', '抹茶', '拿铁', 'dirty', '阿芙佳朵', '澳白', '冷萃', '冰美式'] },
  { cat: '经典名店', kw: ['卡布', '摩卡', '美式', '馥芮白', '焦糖玛奇朵', '意式'] },
  { cat: '自家煎焙', kw: ['手冲', '耶加', '哥伦比亚', '巴西', '日晒', '深烘', '法兰绒', '单品', '浅烘', '中烘', '咖啡', '豆'] }
]

function guess(name, desc) {
  const text = ((name || '') + ' ' + (desc || '')).toLowerCase()
  for (const r of RULES) {
    if (r.kw.some(k => text.indexOf(k.toLowerCase()) >= 0)) return r.cat
  }
  return '自家煎焙' // 兜底：未命中任何关键词 → 自家煎焙
}

async function ensureCategories() {
  const res = await db.collection(COL.categories).orderBy('sort', 'asc').get().catch(() => ({ data: [] }))
  const exist = res.data || []
  const byName = {}
  exist.forEach(c => { byName[c.name] = c._id })
  for (const d of DEFAULT_CATS) {
    if (!byName[d.name]) {
      const add = await db.collection(COL.categories).add({ data: { name: d.name, sort: d.sort, icon: '', createdAt: Date.now() } })
      byName[d.name] = add._id
      console.log('  + 创建类目:', d.name)
    }
  }
  return byName
}

async function dump() {
  const cats = await ensureCategories()
  const res = await db.collection(COL.products).where({}).get().catch(() => ({ data: [] }))
  const products = res.data || []
  const rows = products.map(p => ({
    _id: p._id,
    name: p.name,
    projectId: p.projectId,
    desc: (p.desc || '').slice(0, 60),
    currentCategoryId: p.categoryId || '',
    suggestedCategory: guess(p.name, p.desc),
    categoryId: cats[guess(p.name, p.desc)] || ''   // 预填：用户确认时一般无需改
  }))
  fs.writeFileSync(MAPPING, JSON.stringify(rows, null, 2))
  const md = ['# 存量菜品归类对照表', '', '> 由 `node scripts/migrateCategories.js dump` 自动生成。请逐项核对 `suggestedCategory`，',
    '> 如需改类目，编辑 `category-mapping.json` 中对应行的 `categoryId`（按下方类目名→ID 映射），再运行 `apply`。', '',
    '## 类目名 → ID', ...Object.keys(cats).map(n => `- ${n}: ${cats[n]}`), '',
    '| 菜品 | 项目 | 当前类目ID | 建议类目 |', '| --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.name} | ${r.projectId} | ${r.currentCategoryId || '(空)'} | ${r.suggestedCategory} |`)
  ].join('\n')
  fs.writeFileSync(MAPPING_MD, md)
  console.log(`\n已生成对照表：${MAPPING}（${rows.length} 道菜）与 ${MAPPING_MD}`)
  console.log('请核对后运行：node scripts/migrateCategories.js apply')
}

async function apply() {
  if (!fs.existsSync(MAPPING)) { console.error('找不到对照表，请先运行 dump'); process.exit(1) }
  const rows = JSON.parse(fs.readFileSync(MAPPING, 'utf8'))
  let done = 0
  for (const r of rows) {
    if (!r._id || !r.categoryId) continue
    await db.collection(COL.products).doc(r._id).update({ data: { categoryId: r.categoryId } })
    done++
  }
  console.log(`已写入 ${done} 道菜的类目。未写：缺失 _id 或 categoryId 的条目（已跳过）。`)
}

const mode = process.argv[2] || 'dump'
if (mode === 'dump') dump().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
else if (mode === 'apply') apply().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
else { console.error('用法: node scripts/migrateCategories.js [dump|apply]'); process.exit(1) }
