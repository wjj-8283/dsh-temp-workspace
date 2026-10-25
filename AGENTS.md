# AGENTS.md — @wjj-8283/dsh-temp-workspace

DSH Web 客户端插件：**临时工作区**。点侧栏 “+ 添加工作区” 旁的小沙漏图标即可建一个一次性
工作区并开新会话；下次 Harness 重启时删除该工作区的会话与工作区本身；也可 “pin” 到某个
文件夹永久保留（文件搬入 + 会话迁移 + 宿主级重启）。

## 项目结构

```
temp-workspace-plugin/
├── package.json       包名、dsh.bundle.patch、dsh.client(inject: workspaces/slots/locale)、scripts
├── cordis.patch.yml   把本插件作为宿主 Loader 条目插入（id: dsh-temp-workspace）
├── lib/index.js       node 半边：/temp-workspace/api 路由 + Config schema + 启动清理
├── src/client.js      浏览器半边源码：图标按钮 + Settings 页面 + 确认弹窗
├── lib/client.js      构建产物（已提交，勿手改）
├── build.mjs          src/client.js -> lib/client.js（--watch / --check）
├── CHANGELOG.md       版本记录
├── screenshots/       文档截图（screenshots.json 是清单）
└── README.zh.md       中文说明（README.md 为英文）
```

## 内容

- 临时工作区是一个普通 registry Workspace，指向 `<dsh-home>/temp-workspaces/<uuid>` 的一次性目录；
  `<dsh-home>/temp-workspaces/state.json` 记录 `{ workspaceId, path, createdAt }`，是
  **目录清理的真相来源**（registry 记录已被 UI 删掉时，重启后仍能清掉遗留目录）。
- 清理顺序：live 会话先拆解（cancel / archive / detach）→ 冷会话 archive → 删磁盘上的 session
  目录 → `workspaceRegistry.delete(id)` → 删一次性目录；另会清理 projection-cache 残留
  （启动时 `pruneOrphanTempResidue` 孤儿清扫）。
- 永久保留（pin）：目录选择器选文件夹 → 文件直接移入（不再套子目录）→
  目录名作为工作区标题 → 迁移会话（重写每个 session log 头部帧的 `cwd`，其余帧字节不变）→
  记 pending-attach，下次启动重新挂到新工作区 → 客户端弹窗**只说明手动重启步骤**，不再提供
  「立即重启」按钮（桌面端无法重启自己的宿主进程：Electron shell 持有窗口，杀掉里面的 web host
  只会让应用不可用）。宿主仍保留 `POST restart` 端点，但界面不再调用它。
  宿主半边的每个阶段都会往 `~/.dsh/temp-workspaces/move-trace.log` 追一行
  （start → destination-ok → sessions-listed → contents-moved → registered →
  old-record-deleted → done）。「点了没反应/一直转」时先看这个文件：最后一行就是卡住的阶段；
  若已到 `keep:done`，问题在客户端而不在宿主。
  行↔条目**不要按下标配对**：工作区行由注册表顺序渲染，marker 是创建顺序，还可能残留目录
  已删的条目。侧栏工作区行自带 `data-row-key="workspace:<workspaceId>"`（会话行是
  `session:<id>`），按它绑定按钮才是精确的；`/list` 还会给目录已消失的条目打
  `missing: true`，这类条目不该画图钉（点了只会 409）。
  选择器与「开新会话」在 dsh 0.2.x 已从 `workspaces` 数据服务搬到 `uiWorkspace` UI 服务
  （`startSession` / `pickDirectory`）；桌面端另有 `globalThis.__DSH_DIRECTORY_PICKER__`
  原生选择器桥（取消返回 `null`，无需 inject）。客户端用 `workspaceActions()` 在点击时惰性
  解析，别再写死 `workspaces.pickDirectory()`。
  **不要读 `ctx.remote.directoryPicker`**：命名空间化的 remote 要求本 fiber 在 `inject`
  里声明 `'remote.directoryPicker'`，否则 cordis 直接抛
  `cannot get property "remote.directoryPicker" without inject`；`ctx.get('uiWorkspace')`
  这种 `ctx.get(name)` 才是免 inject 读取（cordis 的 reflect.get 文档写的是 "without the
  inject requirement"）。
  会话日志在 0.2.x 是 `<sessions>/<projectKey>/<sessionId>/session.vN.jsonl.zstd`（每会话一个
  目录、每个格式代次一个文件），迁移按家族正则识别，不能用固定的 `session.jsonl.zstd`。

## 用法

```sh
# npm 预构建安装（推荐，无构建步骤）
dsh plugin --profile web add @wjj-8283/dsh-temp-workspace
# 本地检出 / GitHub 安装
dsh plugin --profile web add /path/to/dsh-temp-workspace
dsh plugin --profile web add github:wjj-8283/dsh-temp-workspace#<ref>

# 开发循环
node build.mjs --watch      # 改 src/client.js -> HMR
node build.mjs              # 单次构建
node build.mjs --check      # 校验 lib/client.js 与 src/ 同步（CI / prepublish）
```

### 设置（profile patch 中 entry `dsh-temp-workspace` 的 `config`）

导出 `Config`（schemastery schema）后，Loader 会校验并补默认值，再作为 `apply` 的第二个
参数传入；浏览器半边在 Settings 导航里注册自己的独立页面（`settings.section` 插槽，id 与
`SETTINGS_NS` 同名），页面通过 `/temp-workspace/api/config` 读写这些值。写回走
`ctx.configEditor.edit(ctx.fiber.entry, …)` —— dsh 0.1.7 起旧的
`ctx.settings.register(ns, schema)` 命名空间作用域、`settings.plugin.item` 卡片插槽与
`~/.dsh/settings.yaml` 均已移除。

| key | 值 | 默认 | 含义 |
| --- | --- | --- | --- |
| `deleteMode` | `immediate` / `delayed` | `immediate` | 下次启动立即删，或延迟删 |
| `deleteDelay` | 秒 | `3600` | `delayed` 模式下的宽限期 |
| `confirmBeforeDelete` | 开 / 关 | `on` | 删除前是否弹确认（关掉才自动删） |

### API（`/temp-workspace/api/<method>`，读 GET / 写 POST）

`create`、`list`、`delete`、`config`、`configReset`、`pending`、`confirm`、`keep`、
`permanentKeep`、`restart`（返回结构见 README 的表格）。

## 约定与注意

- **`lib/index.js`（宿主半边）改动必须重启 `dsh web`**；`src/client.js` 走 HMR。
- 保存设置会经 Loader 重跑 `apply()`（同一进程内）。启动清理的状态与"只跑一次"闸门因此
  放在模块作用域的 `boot` 记录上 —— 否则保存设置会重置 `boot.answered`（弹窗重来），并在
  `confirmBeforeDelete` 关闭时立刻删掉用户的临时工作区。
- `lib/client.js` 是生成文件，勿手改；`--check` 用来保证提交的预构建与源码一致。
- 侧栏工作区没有 header slot，图标是用 `MutationObserver` 注入 DOM 的；上游侧栏改版时可能要跟着改。
- 弹窗用自己的 `react-dom/client` root + 内联样式渲染（不依赖 app 的 CSS-module 作用域）。
- 没有公开的 “删除 session log” API（持久化层是 append-only），所以直接删磁盘目录；
  对 live 会话必须**先 flush 再 detach**，否则 `session/disposed` 的 flush 会把已删日志写回来。
- 已知不修的问题见 README 的 “Known bugs that we will not fix”。
