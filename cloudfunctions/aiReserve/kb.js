// kb.js — AI 知识库加载器
// 知识库以 Markdown 形式存于同目录 kb/ 下（store/faq/menu），由本文件在运行时读取并注入 system prompt。
// 维护方式：直接编辑 kb/*.md 文本 → 重新部署 aiReserve 云函数即可生效，无需改代码（单一真相，无漂移）。
const fs = require('fs')
const path = require('path')

function readMd(file) {
  try {
    return fs.readFileSync(path.join(__dirname, file), 'utf8').trim()
  } catch (e) {
    return ''
  }
}

module.exports = {
  store: readMd('kb/store.md'),
  faq: readMd('kb/faq.md'),
  menu: readMd('kb/menu.md')
}
