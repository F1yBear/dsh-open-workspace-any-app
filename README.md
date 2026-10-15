# dsh-open-workspace-any-app

在 DeepSeek Harness 的会话头部加一个「用其它应用打开」按钮：把当前工作区目录交给**任意应用** —— Zap、Qoder IDE、IntelliJ IDEA、Obsidian、HBuilderX，或任何你能写出启动方式的东西。

它和内置的 `open-in-app` 控件**并排共存**，互不遮挡。

## 交互

- **按钮上就是这个应用的图标。** 不用展开菜单、不用看提示文字，一眼知道点下去会开哪个应用。
- **记住上一次的选择。** 你上次用谁打开，下次按钮就是谁（跨会话、跨浏览器重启）。选中的那项在菜单里带勾。
- **在界面里增删应用。** 菜单底部「管理应用…」打开一个对话框：
  - 已经装好但还没进菜单的应用会列在「发现」区里，点一下即加入 —— 不需要知道 `.app` 路径。
  - 每一项都有 **移除** 按钮 —— **包括 `cordis.patch.yml` 里声明的应用**。
  - 移除的应用进入「已移除」区，可以一键放回。
- **对话框是固定视窗，不随列表变高。** 卡片最高 520px 且不超过窗口，列表在卡片内滚动 —— 一台机器装着几百个应用，「发现」列表**默认只显示前 6 条**，其余靠搜索。
- **顶部有搜索框。** 三段列表（菜单中 / 已移除 / 发现）**一起**被过滤：输入关键字后不再截断，匹配到的全部列出；清空就回到 6 条。

  增删都立刻生效，**不需要重启 DSH**。

> **Open the workspace directory in any app you declare**, beside the built-in open-in-app control.

---

## 为什么需要这个插件

DSH 自带的 `@deepseek-ai/dsh-host-open-in-app` 解析的是一张**构建期固定**的目录表：

- `OPEN_IN_APP_CATALOG` 是模块级常量，**没有**出现在包的 `exports` 里，外部 `import` 不到；
- 解析器读取主机事实要经过模块私有的 `internals` 缝（`lib/types/internals.js` 里是 `{ catalog: {} }`，生产环境刻意留空），插件**无法注入**；
- 它的 `Config` 只接受三个超时字段，**没有**应用列表字段。

所以内置表里没写的应用（Zap、Qoder IDE、HBuilderX、Obsidian）既不能靠配置追加，也不能被插件从外部扩展。

插件**能做**的是：在旁边挂自己的路由、在会话头部注册自己的格子。这正是本包的做法。

| | 本插件 | 改内置白名单 |
|---|---|---|
| 你的编辑器能出现 | ✅ 独立按钮，列出你声明的全部应用 | ✅ 融进内置下拉 |
| 改动官方安装包 | ❌ 不动 | ✅ 要改 asar |
| 破坏代码签名 | ❌ 不破坏 | ✅ 破坏 |
| DSH 升级后 | ✅ 自动保留 | ❌ 每次重做 |
| 与内置菜单的关系 | 两个控件并列 | 一个控件 |

---

## 安装

在 DSH 的插件页安装本包，或让 Agent 通过 `plugin_manager` 安装。装完**重启 DSH**（新装的 JS 模块需要重新加载一代）。

安装后：

1. `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，Profile 会把它作为一层 patch 应用；
2. patch 里的 `insert` 把 `dsh-open-workspace-any-app` 这一行加进 Profile；
3. `package.json` 的 `dsh.client` 声明让浏览器端发现 `exports["./client"]` 这个客户端产物。

## 配置

应用列表是**数据**，写在 `cordis.patch.yml` 的 `config.apps` 下，或你在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里覆盖。

```yaml
- id: open-workspace-any-app
  name: dsh-open-workspace-any-app
  config:
    launchWatchMs: 1000
    apps:
      - id: zap                      # 稳定 id：启动请求和图标 URL 都用它寻址
        label: Zap                   # 菜单显示名；省略则用 id
        locators:                    # 按顺序尝试，第一个在此机器上验证通过的胜出
          - kind: app                # app = 按绝对路径的应用程序包
            paths:
              - /Applications/Zap.app
              - ~/Applications/Zap.app
```

### 定位器（locator）

| kind | 含义 | 默认启动方式 |
|---|---|---|
| `app` | 绝对路径下的应用程序包（macOS `.app`、Linux 应用目录） | `open`：macOS 用 `open -a <bundle> <dir>`，按身份交给 LaunchServices |
| `file` | 绝对路径下的可执行文件 | `argv`：直接运行，目录进 argv |
| `cli` | 通过 `PATH` 解析的命令（`ctx.subprocess.resolveExecutable`） | `argv` |
| `app-paths` | Windows 注册表 `App Paths`（先查 HKCU，再查 HKLM） | `argv` |

**第一个验证通过的定位器胜出**——所以「优先用 CLI，找不到再退回应用包」这样写就行：

```yaml
- id: idea
  label: IntelliJ IDEA
  iconBundle: /Applications/IntelliJ IDEA.app
  locators:
    - kind: cli
      command: idea                 # 优先：启动脚本，天然接受目录
    - kind: app
      paths: [/Applications/IntelliJ IDEA.app]
```

### 目录怎么传给应用

`launch` 省略时按定位器决定：`app` → `open`（按身份打开），其余 → `argv`（可执行文件）。

`argv` 形式下：

- 声明的参数里**没有** `{path}` → 目录**追加**到末尾（编辑器 CLI 想要的形状）：`idea <dir>`；
- 某个参数含 `{path}` → 在该处**替换**：`--cd={path}` → `--cd=/work/project`。

列表顺序 = 菜单顺序。`label` 省略时用 `id`。

### `platforms` 覆盖

`platforms` 里的某个平台**整体替换** `locators`（而不是合并）——和内置目录表把「每平台 spec」当作该平台的完整答案一致：

```yaml
- id: editor
  label: Editor
  locators:
    - kind: app
      paths: [/Applications/Mac.app]
  platforms:
    linux:
      - kind: cli
        command: editor
```

### 图标

- `iconBundle`：包路径，取其 `.icns` 转成 128px PNG（`plutil` + `sips`，macOS 自带）；
- `iconPath`：直接提供的图片文件，按扩展名给 media type 原样送出；
- `app` 定位器在 macOS 上**默认**用自己的包当图标来源。

图标是装饰：取不到就 404，浏览器画一个通用字形，**不会**让菜单项消失。

---

## 安全

每个路由都先向组合的 `connection` 服务要一次拒绝判定（`requestRejection`），和内置控件一致：

- **Host/Origin 栅栏**挡住 DNS rebinding 与跨站调用；
- **浏览器认证**（登录 token cookie）在任何目录、图标、启动可达之前就拦下调用方。

在此之上，启动路由在**线缆层**再校验一次请求体：`application/json`、64 KiB 上限、`app`/`path` 必须是字符串、id 必须已解析、路径必须是**绝对路径且指向真实存在的目录**。所以不可信的调用方无法把这个路由变成「运行任意路径」。

`connection` 是**必需**注入：缺了它就是一个没有栅栏的「启动本地应用」端点。（缺少时路由一律 503，而不是无栅栏放行。）

启动的子进程拿到**抹掉凭据的环境**：`*KEY*`/`*PASSWORD*`/`*SECRET*`/`*TOKEN*`、`DSH_*`、`NODE_OPTIONS`、`NODE_PATH` 都不会传下去。

---

## 行为细节

- **一次解析，长期复用**：目录在第一次需要它的请求时解析一次，之后的菜单打开、页面刷新都不再重新探测。
- **装了什么才显示什么**：某台机器上解析不出来的条目，直接不出现在菜单里——一份配置可以服务多台机器。
- **单个条目坏掉不拖垮菜单**：某个定位器抛错（路径不可读、seam 异常）只让**那一条**按「未安装」处理。
- **解析有预算**：`resolveBudgetMs`（默认 15s）到点就用已完成的部分作答，并在响应里带 `truncated: true`，而不是无限等下去。
- **SSH 会话不探测**：远端没有本地 GUI 可开，目录直接为空。
- **启动失败只在观察窗内判定**：子进程在 `launchWatchMs`（默认 1s）后仍在运行 → 计为启动成功并 `unref`（编辑器整个窗口生命周期都在前台）；窗口内非零退出 → 502。

### 配置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `apps` | `[]` | 声明的应用，按菜单顺序 |
| `probeTimeoutMs` | `10000` | 单个定位器解析命令的超时 |
| `iconTimeoutMs` | `10000` | 图标提取命令的超时 |
| `launchWatchMs` | `1000` | 每次启动的早期失败观察窗 |
| `resolveBudgetMs` | `15000` | 单次解析总预算 |
| `storeDir` | `<DSH home>/open-workspace-any-app` | 界面添加的应用存放目录（测试/隔离用） |

重复的 `id` 会在组合期直接**报错**（而不是让后一个静默不可达）。

---

## 无头验证

```bash
npm test                  # 等价于 node --test 'tests/*.test.js'
npm run verify:geometry   # 可选：用无头 Chrome 量对话框的真实布局
```

覆盖：定位器链与平台覆盖、`~`/`${VAR}` 展开、启动 argv 构造（追加 vs `{path}` 替换）、三种 `open`/`argv` 启动路径、解析预算截断、三条路由的注册路径与全部拒绝分支、栅栏缺失/拒绝/放行、重复 id 报错、客户端产物的注册契约与双语字典平衡，以及**真实 HTTP 请求驱动的真实进程启动**（`/usr/bin/true` 成功、`/usr/bin/false` 得 502、不存在的目录得 404）。

对话框另有断言：长扫描在**空搜索时只画 6 行**并提示剩余数量、短列表不提示、查询同时过滤三段并解除截断、查无结果与扫描失败各自的文案、空列表不画搜索框、卡片带着 `max-height` 上限与可滚动正文。客户端测试用的 React 替身**遵守依赖数组**（否则扫描 effect 每次渲染都重跑、搜索框刚输入就被清空，那是浏览器里不会出现的状态），`client.render.test.js` 则用真 React + `react-dom/server` 渲染，确保元素树与 hook 元数没漂。

**几何**是另一回事，上面两条都管不到它：一张画了 200 行、`max-height: none` 的卡片，元素树每个属性都对，只是**布局**不对；`node --test` 没有布局引擎。所以 `npm run verify:geometry` 用无头 Chrome 量真实布局 —— 它从**已安装的 DSH** 里取出真实设计令牌、真实的 `Modal`/`Input` 样式表，再执行 `lib/client.js` 拿到它真正注入的那张样式表，量 4 种视口 × 9 条断言（卡片有上限、卡片在窗口内、按钮与搜索框在屏上、正文可滚动、搜索框吸顶、正文可收缩、滚动条归正文、搜索框撑满）。卡片高度从 **7611px** 变成 **520px**。

这个脚本是**可选**的（要 Chrome + 装好的 DSH），不进 `npm test`。它的断言做过反向验证：把 `max-height` 与 `overflow-y` 去掉，14 条断言立刻失败。

两个坑记在这里：`--dump-dom` 早于异步帧完成，量尺寸要**同步 + 强制回流**，别用 `requestAnimationFrame` 链（否则会把正常工作的 `sticky` 判成坏的）；读 asar 的头部长度要对齐到 4 字节边界（`16 + align4(headerSize)`），差 2 字节就会让每个样式表开头多一个字符，浏览器随即丢掉第一条规则，量出来的 `max-height` 就成了 `none`。

---

## 为什么依赖面这么窄

本包只 import 一个主机依赖 `@deepseek-ai/schemastery`（用于 `Config` schema），其余主机能力都通过 cordis 上下文取：`webServer`、`connection`、`subprocess`。

这不是洁癖。插件从**它被安装进的 Profile** 解析 `@deepseek-ai/*`，而那个 Profile 未必是运行中的应用启动时用的那棵树——两者可以是不同版本。多一个跨包 import，就多一次版本错位让插件在 import 阶段直接失败的机会。所以本包把本来会 import 的两个能力各用几行自己实现了：

- `scrubbedParentEnv()` —— 启动子进程的环境清洗；
- `launchedThroughSsh()` —— SSH 会话判定。

## 交互实现

### 记住选择

用平台自己的快照 store 持久化，写到 `localStorage` 的 `dsh.open-workspace-any-app.choice`：

```js
store.createSnapshotStore('', { persist: { name: 'dsh.open-workspace-any-app.choice' } })
```

这是内置控件同款机制（它用 `dsh.open-in-app.choice`）。存储不可用时（隐私模式、配额）自动退化成内存态，**不会抛错**。

只有**主机确认接受**的启动才会被记住 —— 把一个失败的启动写进存储，会让下次打开时按钮指向一个坏掉的应用。

被记住的应用如果已经不在菜单里了（比如你把它移除了），按钮回退到第一个可用应用，而不是变空。

> 内置控件在这里有个坑：它把持久化的 id 拿 `APP_LABEL_KEY` 硬编码字典过滤，未知 id 会被**静默丢弃**。本插件不过滤，所以自己加的应用不会被吞掉。

### 增删应用

**添加**走对话框里的扫描列表：`GET /discover` 扫描 `/Applications`、`/System/Applications`、`~/Applications`，会排除掉**已经解析成功**的应用，所以「可加的」和「菜单里已有的」不重叠。「发现」区里每一行自带一个添加按钮，点一下即加入 —— 不需要知道 `.app` 路径，也没有平台差异。

**删除**是这个版本修掉的核心问题。它记录为「隐藏」，而不是去改配置：

- 早期版本只允许删除界面添加的应用，结果是**最可能在屏幕上的那些（profile 自带的 5 个声明应用）一个都删不掉**。菜单项能不能删，是关于**菜单**的问题，不是关于这个条目写在哪儿的问题。
- 所以删除统一记为 id 列表 `hidden`。手写的配置**从不被改写**（插件改写操作员的文档，下次手工编辑就得和机器写的行做合并），而且这样删除是**可逆的** —— 对话框能把它们放回。

存储文件 `<DSH home>/open-workspace-any-app/apps.json`：

```json
{
  "version": 2,
  "apps":   [{ "id": "obsidian", "label": "Obsidian", "path": "/Applications/Obsidian.app" }],
  "hidden": ["qoder"]
}
```

`apps` 是界面添加的，`hidden` 是要从菜单隐藏的 id（来自任一来源）。版本 1 只有 `apps`，读到时升级为「没隐藏任何东西」，而不是丢弃。

两份来源在读取时合并（`mergeCatalog`）：手写条目在前且保持顺序；界面条目的 id 或包路径若已被手写条目占用则丢弃 —— 手写的那行优先，绝不静默遮蔽。

移除一个来源里已经没有的 id 是无害的，也不会出现在「可恢复」里（没有东西可恢复）。

### 图标

- `iconBundle`：包路径，取其 `.icns` 转成 128px PNG（`plutil` + `sips`，macOS 自带）；
- `iconPath`：直接提供的图片文件，按扩展名给 media type 原样送出；
- `app` 定位器在 macOS 上**默认**用自己的包当图标来源。

图标是装饰：取不到就 404，浏览器画一个通用字形，**不会**让菜单项消失。

---

## 安全

每个路由都先向组合的 `connection` 服务要一次拒绝判定（`requestRejection`），和内置控件一致：

- **Host/Origin 栅栏**挡住 DNS rebinding 与跨站调用；
- **浏览器认证**（登录 token cookie）在任何目录、图标、启动可达之前就拦下调用方。

在此之上，启动路由在**线缆层**再校验一次请求体：`application/json`、64 KiB 上限、`app`/`path` 必须是字符串、id 必须已解析、路径必须是**绝对路径且指向真实存在的目录**。所以不可信的调用方无法把这个路由变成「运行任意路径」。

`connection` 是**必需**注入：缺了它就是一个没有栅栏的「启动本地应用」端点。（缺少时路由一律 503，而不是无栅栏放行。）

启动的子进程拿到**抹掉凭据的环境**：`*KEY*`/`*PASSWORD*`/`*SECRET*`/`*TOKEN*`、`DSH_*`、`NODE_OPTIONS`、`NODE_PATH` 都不会传下去。

---

## 行为细节

- **一次解析，长期复用**：目录在第一次需要它的请求时解析一次，之后的菜单打开、页面刷新都不再重新探测。
- **装了什么才显示什么**：某台机器上解析不出来的条目，直接不出现在菜单里——一份配置可以服务多台机器。
- **单个条目坏掉不拖垮菜单**：某个定位器抛错（路径不可读、seam 异常）只让**那一条**按「未安装」处理。
- **解析有预算**：`resolveBudgetMs`（默认 15s）到点就用已完成的部分作答，并在响应里带 `truncated: true`，而不是无限等下去。
- **SSH 会话不探测**：远端没有本地 GUI 可开，目录直接为空。
- **启动失败只在观察窗内判定**：子进程在 `launchWatchMs`（默认 1s）后仍在运行 → 计为启动成功并 `unref`（编辑器整个窗口生命周期都在前台）；窗口内非零退出 → 502。

### 配置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `apps` | `[]` | 声明的应用，按菜单顺序 |
| `probeTimeoutMs` | `10000` | 单个定位器解析命令的超时 |
| `iconTimeoutMs` | `10000` | 图标提取命令的超时 |
| `launchWatchMs` | `1000` | 每次启动的早期失败观察窗 |
| `resolveBudgetMs` | `15000` | 单次解析总预算 |
| `storeDir` | `<DSH home>/open-workspace-any-app` | 界面添加的应用存放目录（测试/隔离用） |

重复的 `id` 会在组合期直接**报错**（而不是让后一个静默不可达）。

---

## 无头验证

```bash
npm test                  # 等价于 node --test 'tests/*.test.js'
npm run verify:geometry   # 可选：用无头 Chrome 量对话框的真实布局
```

覆盖：定位器链与平台覆盖、`~`/`${VAR}` 展开、启动 argv 构造（追加 vs `{path}` 替换）、三种 `open`/`argv` 启动路径、解析预算截断、三条路由的注册路径与全部拒绝分支、栅栏缺失/拒绝/放行、重复 id 报错、客户端产物的注册契约与双语字典平衡，以及**真实 HTTP 请求驱动的真实进程启动**（`/usr/bin/true` 成功、`/usr/bin/false` 得 502、不存在的目录得 404）。

对话框另有断言：长扫描在**空搜索时只画 6 行**并提示剩余数量、短列表不提示、查询同时过滤三段并解除截断、查无结果与扫描失败各自的文案、空列表不画搜索框、卡片带着 `max-height` 上限与可滚动正文。客户端测试用的 React 替身**遵守依赖数组**（否则扫描 effect 每次渲染都重跑、搜索框刚输入就被清空，那是浏览器里不会出现的状态），`client.render.test.js` 则用真 React + `react-dom/server` 渲染，确保元素树与 hook 元数没漂。

**几何**是另一回事，上面两条都管不到它：一张画了 200 行、`max-height: none` 的卡片，元素树每个属性都对，只是**布局**不对；`node --test` 没有布局引擎。所以 `npm run verify:geometry` 用无头 Chrome 量真实布局 —— 它从**已安装的 DSH** 里取出真实设计令牌、真实的 `Modal`/`Input` 样式表，再执行 `lib/client.js` 拿到它真正注入的那张样式表，量 4 种视口 × 9 条断言（卡片有上限、卡片在窗口内、按钮与搜索框在屏上、正文可滚动、搜索框吸顶、正文可收缩、滚动条归正文、搜索框撑满）。卡片高度从 **7611px** 变成 **520px**。

这个脚本是**可选**的（要 Chrome + 装好的 DSH），不进 `npm test`。它的断言做过反向验证：把 `max-height` 与 `overflow-y` 去掉，14 条断言立刻失败。

两个坑记在这里：`--dump-dom` 早于异步帧完成，量尺寸要**同步 + 强制回流**，别用 `requestAnimationFrame` 链（否则会把正常工作的 `sticky` 判成坏的）；读 asar 的头部长度要对齐到 4 字节边界（`16 + align4(headerSize)`），差 2 字节就会让每个样式表开头多一个字符，浏览器随即丢掉第一条规则，量出来的 `max-height` 就成了 `none`。

---

## 为什么依赖面这么窄

本包只 import 一个主机依赖 `@deepseek-ai/schemastery`（用于 `Config` schema），其余主机能力都通过 cordis 上下文取：`webServer`、`connection`、`subprocess`。

这不是洁癖。插件从**它被安装进的 Profile** 解析 `@deepseek-ai/*`，而那个 Profile 未必是运行中的应用启动时用的那棵树——两者可以是不同版本。多一个跨包 import，就多一次版本错位让插件在 import 阶段直接失败的机会。所以本包把本来会 import 的两个能力各用几行自己实现了：

- `scrubbedParentEnv()` —— 启动子进程的环境清洗；
- `launchedThroughSsh()` —— SSH 会话判定。

## 交互实现

### 记住选择

用平台自己的快照 store 持久化，写到 `localStorage` 的 `dsh.open-workspace-any-app.choice`：

```js
store.createSnapshotStore('', { persist: { name: 'dsh.open-workspace-any-app.choice' } })
```

这是内置控件同款机制（它用 `dsh.open-in-app.choice`）。存储不可用时（隐私模式、配额）自动退化成内存态，**不会抛错**。

只有**主机确认接受**的启动才会被记住 —— 把一个失败的启动写进存储，会让下次打开时按钮指向一个坏掉的应用。

被记住的应用如果已经不在菜单里了（比如你把它移除了），按钮回退到第一个可用应用，而不是变空。

> 内置控件在这里有个坑：它把持久化的 id 拿 `APP_LABEL_KEY` 硬编码字典过滤，未知 id 会被**静默丢弃**。本插件不过滤，所以自己加的应用不会被吞掉。

### 新增应用

对话框通过 `GET /plugins/dsh-open-workspace-any-app/discover` 拿到扫描结果（`/Applications`、`/System/Applications`、`~/Applications`），排除掉**已经解析成功**的应用，所以「可加的」和「菜单里已有的」不会重叠。

添加写入 `<DSH home>/open-workspace-any-app/apps.json`，**不写** `cordis.patch.yml`：

- 那是操作员手写的文档。让一次界面点击获得改写它的权限，下次手工编辑就得和机器写的行做合并；
- 而且「我在这台机器上装了哪些应用」是关于**机器**的事实，不是关于某个 profile 组合的事实。

两份来源在读取时合并（`mergeCatalog`）：手写条目在前且保持顺序；界面添加的条目里，若 id 或包路径已被手写条目占用则**丢弃** —— 手写的那行优先，绝不静默遮蔽。

添加后会立即重建目录，**无需重启**。移除只能移除界面添加的条目；手写条目拒绝移除（404），因为那属于 `cordis.patch.yml`。

### 对话框为什么是固定视窗

**问题**：这个对话框列的是「本机装了什么」，而一台机器有几百个 bundle。早期版本把它们**全部**渲染进一张按内容撑高的卡片里 —— 卡片于是比窗口还高，不仅列表项滚不到，连卡片底部的按钮也一起跑到屏幕外，而且**没有任何滚动条**。实测（1280×633 视口、200 个候选）：卡片高 **7611px**，`max-height` 为 `none`，页脚与搜索框都在视口外。

**修法**，三件事一起才成立：

1. **卡片有上限**：`.dsh-open-any-app-dialog { max-height: min(520px, 100%) }`。`100%` 相对的是 `Modal` 图元的 padding box（它给了一个撑满视口的 flex 容器、四周 24px 内边距），所以卡片**永远不会高过窗口**。这与 `@deepseek-ai/dsh-client-ui-plugin-manager` 的安装对话框是同一种写法（`max-height: min(800px, 100%)`）。
2. **正文要能收缩**：只在卡片上设上限不够 —— flex 子项默认 `min-height: auto`，内容会把卡片顶破上限。所以正文那层是 `min-height: 0`，再加 `overflow-y: auto`，溢出才变成滚动条而不是被裁掉。
3. **列表要截断**：`GET /discover` 最多返回 200 条，全画出来没有意义，「发现」段在**搜索框为空时只画前 6 条**，并用一行小字说明还剩多少、可以输入关键字。输入任何查询就解除截断 —— 此时你已经说了要找什么。

实测同一场景：卡片 **520px**，完整落在窗口内，页脚与搜索框都在视口里，正文可滚动（`scrollHeight` 579 > `clientHeight` 440），每一行都够得着。

**搜索框**吸顶（`position: sticky`）在正文顶部，所以列表往下滚时它不会跑掉。它过滤的是**三段一起**：一个人找应用时知道的是名字，不是它恰好落在哪一段。查询匹配不到任何东西时，文案是「没有匹配……的应用」而不是「没有发现新应用」—— 后者会把一次失败的搜索说成一台没有装东西的机器。

失败的扫描也单独说：`GET /discover` 报错时显示「无法读取本机应用」，不再冒充「没有发现新应用」。

样式表由 bundle 注入一张 `<style>` 标签（内联 style 写不了 `:hover`、滚动条和 placeholder）。注入点在 **factory 作用域**，不是 `apply()` —— 这一点是功能性的：加载器在 factory **返回后立刻**用 `claimStyles` 认领本插件的 style 标签（给未标记的标签盖上包名），重载时只删它认识的标签。在 `apply()` 里创建就晚了一步，标签永远无主，每次重载都会留下一份陈旧副本。所以标签创建时就自报家门（`data-plugin` + `data-plugin-css`），和编译产物的 CSS-module bundle 走的是同一条路。

### 图标

按钮面用 `<img>` 指向本插件自己的图标路由（`/plugins/dsh-open-workspace-any-app/icon/<id>`），不是内置控件那个。解析不到图标时回退成通用字形，不会出现破图。

## 已知限制

- **应用必须能通过绝对路径或 `PATH` 找到**。装在非标准位置、或包名与声明不符的应用，请直接把真实路径写进 `paths`。
- **图标提取依赖 macOS 的 `plutil`/`sips`**；其他平台请用 `iconPath` 提供图片。
- **界面新增的应用立刻生效**，不需要重启。但**改 `cordis.patch.yml` 里手写的条目需要重启**：主机端模块按 URL 缓存，DSH 的 HMR 默认忽略 `**/node_modules`（插件正是从 profile 的 `node_modules` 软链进来的），所以配置层能热重载、插件代码本身不能。
- **界面添加只支持 macOS 应用包（`.app` 目录）**：扫描列表枚举的是 bundle。`kind: cli`、`{path}` 参数这类高级写法仍然要写进 `cordis.patch.yml`。
- **同时只能有一个控件**占用 `conversation.session.header.utilities` 里 `id: 'open-any-app'` 这个格子；重复注册同 id 会被槽位拒绝。
- Windows 的 `app-paths` 定位器需要 `reg.exe`；非 Windows 平台上该定位器直接判为不存在。

## 许可

MIT
