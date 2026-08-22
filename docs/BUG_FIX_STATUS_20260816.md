# 小程序 Bug 修复状态 · 2026-08-16

环境：`cloud1-d8g9mhgxm32d2eac6` · AppID `wxb97578ed89c6e2c7`

## 一、已修复并上线（前端 6.4.1，体验版可测）

| Bug | 根因 | 修复 | 状态 |
|---|---|---|---|
| **5. 提交预约后跳"我的预约"** | `confirm.js` 用 `wx.redirectTo` 跳转到 tabBar 页，微信要求 `wx.switchTab`，原跳转静默失败 | 改为 `wx.switchTab({url:'/pages/mine/mine'})` | ✅ 已上线 6.4.1 |
| **3. 项目配置页标签/步进器/当前项目名** | 标签为"次数上限/提前天数"；用数字输入框；header 依赖被污染的 `getProjectAdmin`，云端坏时显示"选择项目" | 标签改为"每日预约次数上限 / 预约提前开放天数"；两处改为 −/+ 步进器；header 改用项目列表名乐观显示（云端坏也能显示当前项目名）；并对 `getProjectAdmin` 异常做防御（不再整页崩溃） | ✅ 已上线 6.4.1（注：配置页的日历/场次/全局设定仍需 `getProjectAdmin` 正常才能加载，见下） |

> 上线动作：`deploy/upload.js`（miniprogram-ci）上传 71 文件，version 6.4.1。请在微信公众平台把该版本设为**体验版**，用店主微信扫码验证。

## 二、被云端部署阻塞、暂未修复（需部署通道）

经实测确认：**`tcb` CLI 已完全无法部署/更新云函数代码**（报告"成功"但不替换代码，已在 `listProjects` 打标记日志验证；新建函数走云端 `BuildCodeViaSCF` 报 `mjs: command not found` 平台回归）。本地 `cloudfunctions/` 源码全部正确就绪，但**唯一曾成功的部署通道是 CloudBase MCP 连接器，当前已断开**。

| Bug | 根因（云端） | 需要的云端动作 | 本地源码状态 |
|---|---|---|---|
| **1. 删除项目"提示成功但项目还在"** | `listProjects` 未过滤已软删除项目，删除后仍在列表 | 部署 `listProjects`（已加 `!p.deleted` 过滤） | ✅ 已改好，未生效 |
| **2. 场次模版配置未生效** | `listTemplates`/`saveTemplate`/`deleteTemplate` 三个函数云端跑的是 getHomepage 代码（被 `tcb fn copy` 污染冻结） | 重传这 3 个函数正确代码 | ✅ 本地正确 |
| **3（深层）项目配置页数据加载** | `getProjectAdmin` 云端跑 getHomepage 代码，返回的 `project` 为空，整页配置无法加载 | 重传 `getProjectAdmin` 正确代码 | ✅ 本地正确 |
| **4. 店铺菜单管理保存报错 / 顾客端点菜单报错** | 菜单相关函数 `getMenu`/`listProducts`/`saveProduct`… 从未部署（Function not found）；`products`/`reviews` 集合未建 | 创建并部署菜单/评价/SMS 函数 + 建 `products`/`reviews` 集合 | ✅ 本地正确 |

## 三、需创建/修复的云端函数清单

- **被污染需重传（4 个）**：`getProjectAdmin`、`listTemplates`、`saveTemplate`、`deleteTemplate`
- **从未部署、缺失（12 个）**：`getMenu`、`listProducts`、`saveProduct`、`getProduct`、`addReview`、`adminProducts`、`deleteProduct`、`adminReviews`、`setReview`、`getSmsConfig`、`saveSmsConfig`、`deleteProjectFile`
- **需手动建的集合（2 个）**：`products`、`reviews`

## 四、恢复部署的唯一路径（二选一，需你操作）

1. **重连 CloudBase MCP 连接器**：左侧「连接器」→ 找到 **CloudBase** → 点「信任/连接」。连上后我可一次性把上述全部函数与集合部署到位。
2. **云函数控制台手动粘贴**：对单函数，到 CloudBase 控制台打开对应函数，把 `cloudfunctions/<fn>/index.js`（同目录的 `lib.js` 也要一起）源码粘贴保存并部署。适合先修 `getProjectAdmin`/`listProjects` 等单点。

> 备注：本机 `tcb` 任何 `fn deploy` / `fn code update` 尝试都无效，请勿再走此路，直接走 MCP 或控制台。

## 五、后续建议顺序（MCP 重连后）

1. 重传 `getProjectAdmin`（配置页恢复）
2. 重传 `listProjects`（删除项目即消失，Bug 1 收口）
3. 重传 `listTemplates`/`saveTemplate`/`deleteTemplate`（Bug 2 收口）
4. 建 `products`/`reviews` 集合 + 部署 `getMenu`/`listProducts`/`saveProduct` 等（Bug 4 收口）
5. 部署 SMS/评价等其他缺失函数
