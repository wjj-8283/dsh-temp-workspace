# @wjj-8283/dsh-temp-workspace

一个 DSH web **客户端插件**，提供 **临时工作区（临时工作区）** 功能。

点击侧边栏「添加工作区」(+)右侧的小沙漏图标，即可创建一个一次性工作区并打开一个全新的对话。下次 Harness 重启时，这个插件会**删除该工作区下的全部对话以及工作区本身**——临时工作区不留任何痕迹。

## 它是什么

- **宿主半边**（`lib/index.js`）—— 一个 Cordis 插件，注入
  `webServer` / `webRuntime` / `workspaceRegistry` / `sessionPersistence`、
  `settings` 和 `loader`，注册受浏览器信任围墙保护的 `/temp-workspace/api` 路由，
  并在启动时驱动清理逻辑。
- **浏览器半边**（`src/client.js` → `lib/client.js`）—— 在侧边栏「+ 添加工作区」
  按钮旁注入一个小图标；点击后调用宿主路由，并在新建的工作区里打开一个新对话。
  它还注册了一张 **设置 → 插件** 卡片，并在设置开启时于启动阶段弹确认对话框。

## 安装方式

### 从 npm 安装（预构建，推荐）

该包已发布到 npm，`lib/` **为预构建产物**，安装无需构建、可跳过 pnpm 的 `allowBuilds` 授权——一条命令搞定：

```sh
dsh plugin --profile web add @wjj-8283/dsh-temp-workspace
```

`dsh plugin … add` 会把该 spec 转发给 profile 目录里的 pnpm，并代为合并 `dsh.profile.bundles`。因为清单声明了 `dsh.bundle.patch`，包会自动加入 Loader 层栈，下次启动 `dsh web` 时宿主把它组合为 Loader 条目、注册 `/temp-workspace/api` 路由、设置卡片进入 `__DSH_BOOT__`。

改动后重新发布（需要拥有 `@dsh-dev` scope 的 npm 账号）：

```sh
npm login                # 一次即可
npm publish               # prepublishOnly 会从 src 重新生成 lib/client.js
```

### 从 GitHub 安装

直接从 GitHub 安装，使用 `dsh plugin` 转发器（在 profile 目录里 pnpm clone + `add`，并自动合并 bundle 层）：

```sh
# 启动某个 profile，例如 web 应用
dsh plugin --profile web add github:wjj-8283/dsh-temp-workspace
```

因为清单声明了 `dsh.bundle.patch`，add 会把该包自动追加到 `dsh.profile.bundles`，下次启动 `dsh web` 时宿主就把它组合为 Loader 条目、注册 `/temp-workspace/api` 路由、设置卡片进入 `__DSH_BOOT__`。

若想自己驱动 pnpm，可在 profile 目录里执行同一 spec：

```sh
cd "$DSH_HOME/profiles/web"
pnpm add github:wjj-8283/dsh-temp-workspace
```

要固定到某个分支/标签/提交，按 pnpm 的 git ref 语法追加：

```sh
dsh plugin --profile web add github:wjj-8283/dsh-temp-workspace#<ref>
```

> 构建后的客户端 bundle（`lib/client.js`）已提交在仓库里，所以 git 安装不需要构建步骤。要改它，克隆仓库后用 `node build.mjs --watch`（见[开发循环](#开发循环)），或改为从本地 checkout 安装（见[接入 profile](#接入-profile)）。

## 设置 → 插件

插件在 **设置 → 插件** 注册一张卡片（以设置命名空间 `dsh-temp-workspace` 为键，
持久化在 `~/.dsh/settings.yaml`）：

| 设置 | 取值 | 默认 | 含义 |
| --- | --- | --- | --- |
| `deleteMode` | `immediate` / `delayed` | `immediate` | 下次启动时何时删除临时工作区 |
| `deleteDelay` | 秒 | `3600` | `delayed` 模式下删除前的宽限期 |
| `confirmBeforeDelete` | 开 / 关 | `开` | 删除前是否先询问用户 |

- `confirmBeforeDelete` **开**：宿主启动时绝不自动删除，而是挂起这些工作区，
  浏览器弹出**确认对话框**，提供两个选项：
  - **删除** —— 清空被挂起的工作区（会话 + 注册 + 目录）。
  - **临时保留** —— 本次不动它们，但**仍然是临时**：它们还在标记里，会在之后的
    启动时再次（按设置）被确认/清理。
  - 未作答时工作区原样保留到下次启动。

**永久保留**不在启动确认弹窗里——它有**自己的按钮**。侧边栏里每个临时工作区行
（标题「临时工作区」）在其「＋」(New Session) 旁边有一个**图钉**按钮。点击后选取一个
目标文件夹（通过 `ctx.workspaces.pickDirectory()` 的系统目录选择器）。临时工作区的文件会
**直接移进该文件夹**（不会额外创建「临时工作区」子文件夹），该文件夹本身成为永久工作区，
并用**其文件夹名作为工作区标题**。同时**迁移对话**：把每个会话日志头行的 `cwd` 改写为该
文件夹路径，并把日志目录移到新 `cwd` 的 projectKey 槽位。成功后弹出一个**不可关闭**的
对话框，带 **「立即重启」** 按钮——它触发**真正的宿主级重启**（一个脱离的辅助进程按原
DSH 启动命令重新拉起，机制与 `dsh-market` 更新插件时一致），让注册表重新索引、迁移的对话
出现在新工作区下。
- `confirmBeforeDelete` **关**：自动删除——启动时立即执行，或在 `deleteMode = 'delayed'`
  时等待 `deleteDelay` 秒后执行。

## 清理是如何工作的

DSH **没有公开的「删除会话日志」API**——持久化层是 append-only。所以临时工作区的删除分为四步：

0. **先拆在线会话** —— 如果宿主进程里还活着该工作区的会话（确认弹窗、延迟自动删除、或只刷新了页面而宿主并未真正重启时，删除都会在仍持有这些会话的宿主里运行），会尽力拆除它们：
   先取消 agent 并等它回到空闲（`whenIdle`，镜像 agent loop 自身的销毁顺序），再**先把待写内容落盘**
   （`sessions.flush`），最后从会话存储中摘除该条目（发出 `session/disposed`，客户端立即关闭该对话）。
   **先 flush 再摘除对多会话工作区至关重要**：摘除会触发 `session/disposed`，持久化协调器随之做一次
   "退休刷新"（retire → flush → initFor），若会话还有未落盘的写入，这次刷新会在目录被删除后把日志
   重新物化出来——那些会话就会变成不可读取的 Ungrouped 残留。先 flush 后，退休刷新无内容可写，日志
   只会被删除一次。
0b. **归档冷会话** —— 本轮宿主里从未被打开（未 attach）的会话只有磁盘日志，删日志后浏览器收不到
   `session-removed` 事件，会在侧边栏残留成不可读取的 Ungrouped 条目。`archiveColdSessions` 在删日志
   **之前**把它们逐一归档（`workspaceRegistry.archiveSession`）：归档集变化会推送
   `host/archived-sessions-changed`，侧边栏（分组、扁平列表、搜索）都会过滤归档 id，残留条目立即消失。
   归档留下的 archived-id 记录由启动清扫回收。
1. **再删会话** —— 工作区所属的每个会话（其头行 `cwd` 等于工作区路径）通过
   `ctx.sessionPersistence.locate` 定位，并用 `fs.rm` 删除其磁盘目录。
2. **删注册** —— `ctx.workspaceRegistry.delete(id)` 删除工作区记录（本身不动日志/目录）。
3. **删目录** —— 删除临时目录（位于 `<dsh-home>/temp-workspaces/<uuid>`）。

插件用 `<dsh-home>/temp-workspaces/state.json` 记录临时工作区（持久化标记
`{ workspaceId, path, createdAt }`）。删除由该标记里的 `path` 驱动，所以重启前已通过
UI 删除注册记录的临时工作区**仍会清理残留目录**（修复了「残留文件夹」bug）——目录以
标记路径（而非注册记录）为准。

**零残留**：删除时还会清理会话的**投影缓存行**（`session_projcache` 域，位于
`~/.dsh/storages/session_projcache.json`）与旧布局遗留的 per-session 缓存文件。
启动时还有一次**孤儿残留清扫**（`pruneOrphanTempResidue`）：凡 `cwd` 位于临时根目录下、
且不再被标记引用的投影缓存行，连同其 archived-id 记录与遗留缓存文件一并删除。这些行
永远不会把幽灵对话显示出来（身份校验后读不到），但"不留痕迹"就是不留痕迹；用户对真实
会话的主动归档不会被触碰。

## 目录结构

```
temp-workspace-plugin/
  package.json       name, dsh.bundle.patch + dsh.client, exports
  cordis.patch.yml   把该插件插入为宿主 Loader 条目
  lib/index.js       节点半边 —— /temp-workspace/api 路由 + 设置 + 启动清理
  src/client.js      浏览器半边源码（图标 + 设置卡片 + 确认弹窗）
  lib/client.js      构建后的浏览器半边（生成文件，勿改）
  build.mjs          把 src/client.js 包装 -> lib/client.js（HMR watch）
```

## 开发循环

```sh
node build.mjs --watch
```

`lib/client.js` 是 client-modules 提供、dsh-client-hmr 轮询的**唯一文件**；编辑
`src/client.js` 会热更新界面（无需刷新页面）。**宿主半边改动**（`lib/index.js`）需要重启
`dsh web`。

## 接入 profile

```sh
# 本地 checkout / clone（任意绝对或相对路径）
dsh plugin --profile web add /path/to/dsh-temp-workspace
```

这会把它加入 `dsh.profile.bundles`。下次启动 `dsh web` 时宿主组合该行、
注册 `/temp-workspace/api` 路由、设置卡片进入 `__DSH_BOOT__`，并运行启动清理/确认流程。

## API（`/temp-workspace/api/<method>`）

读取用 `GET`，变更用 `POST`。

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `POST create` | `{ workspace, created: true }` | mkdir + `workspaceRegistry.create` + 标记 |
| `GET list` | `{ entries }` | 当前标记为临时的 `[{ workspaceId, path, createdAt }]` |
| `POST delete` | `{ ok: true }` | 立即删除一个临时工作区（会话 + 注册 + 目录） |
| `GET/POST config` | `{ ok, value }` | 读取设置，或 `POST {…}` 写入补丁 |
| `POST configReset` | `{ ok, value }` | 恢复所有设置为默认 |
| `GET pending` | `{ ok, value }` | 被挂起的工作区 + `confirmBeforeDelete` + `deleteAt` |
| `POST confirm` | `{ ok, deleted }` | 用户确认——删除被挂起的集合 |
| `POST keep` | `{ ok, kept }` | 临时保留——不动作（仍为临时） |
| `POST permanentKeep` | `{ ok, moved }` | `{ target, workspaceId? }` —— 把 `target`（所选文件夹）直接作为新工作区并去临时化；带 `workspaceId` 时只移动该工作区（省略则移动全部被挂起的） |
| `POST restart` | `{ restarting, pid, helperPid }` | 真正的宿主重启（仅限同源 loopback） |

## 说明 / 局限

- 侧边栏工作区浏览器**没有**给头部动作用的 slot，所以图标是用 `MutationObserver`
  注入 DOM 的（与 `dsh-workspace-auto-approval` 同款写法）。若上游侧边栏布局改变，
  图标可能需要相应调整位置。
- 「添加工作区」按钮只在目录流槽位被占用时才渲染，因此临时工作区图标也只在此时出现。
- 清理时直接删除会话日志目录。**在线**会话会在删除时尽力拆除（取消 agent + 归档 + 从会话存储
  摘除），因此即使删除发生在仍持有这些会话的宿主进程里（确认弹窗、延迟删除、页面刷新），对话也会
  立即从界面消失；启动时没有在线会话，正是清理运行的时候。
- 临时工作区的目录位于 DSH home（`~/.dsh/temp-workspaces`），不在你的常规项目文件夹里。
- 浏览器插件没有通用的「询问用户」API，因此确认弹窗由插件自绘（轻量内联样式遮罩），
  通过自己的 `react-dom/client` root 渲染（不依赖 primitives 的 CSS-module 作用域，所以必定显示）。
- **永久保留**需要 `native` 目录选择器能力（`ctx.workspaces.pickDirectory()`）；
  在远程/非 native 部署下该选择器不可用，按钮会被禁用。
- 对话迁移只改写每个会话日志的**头帧**（`.jsonl.zstd` 是一串独立压缩的 Zstandard 帧
  连接而成——帧 0 是带 `cwd` 的头行，其余是事件批次）。头帧的 `cwd` 被改写，每个事件帧
  逐字节保留，因此不会丢失任何对话内容。
- DSH 会话头中的 `cwd` 不可变，故采用改写方式。DSH 工作区注册表的「会话→工作区分组」
  （`bootstrap`）**只在第一次启动时运行一次**；之后的启动只会重建 id→cwd 索引，不会把
  迁移后的会话加进新工作区的 `sessionIds`。为避免迁移的对话最终变成**未分组**，插件在
  移动时记录一条持久化的 **pending-attach** 列表，并在下次启动时把这些迁移会话重新挂载到
  新工作区——这也是永久保留后客户端提示重启的原因。

## 不准备修复的Bug

- 受到Harness的限制，永久保留后对话有概率变成`Ungrouped`，已经尽力处理了，但是仍然有概率出问题
- 创建临时工作区后永久保留相关按钮不一定会立即出现，但是肯定会在一段时间后（2-3s后）出现的，不准备修复
- 受到Harness的限制，迁移过程完成后对话的名称有概率变成工作区的名称，点击后又变回原来的名称，不影响使用，不计划修复，自己改一下名应该就可以处理这个问题

## 界面语言

所有界面文案（图标按钮、行内“永久保留”按钮、设置卡片、确认/重启弹窗）都提供**中文与英文**
两套字典，并跟随 DSH 的激活语言自动切换（`ctx.locale` + `locale.subscribe`），语言切换时
已注入的按钮文案也会刷新。
