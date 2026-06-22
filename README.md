# 沉浸式翻译 (Immersive Translation)

一款基于 DeepSeek API 的浏览器翻译插件，自动识别网页中的英语/日语文本，在原文下方插入简体中文翻译。支持 Chrome 和 Edge (Manifest V3)。

## 功能

- **自动页面翻译** — 检测页面中的英文/日文内容，在原文下方插入简体中文翻译
- **智能元素过滤** — 跳过导航栏、页脚、侧边栏、代码块、交互元素、纯数字/日期/@提及/UI标签
- **内容区域感知** — 识别 `<main>`, `<article>` 内容容器，精准翻译核心区域
- **滚动延迟翻译** — IntersectionObserver (500px 预加载) + 滚动停止兜底扫描 (150ms)
- **批量翻译** — 每批 20 个元素，80ms 防抖，高效利用 API
- **缓存机制** — 内容哈希缓存 (djb2)，7天 TTL，最多 5000 条，自动淘汰
- **API 可靠性** — 3次指数退避重试 + 熔断保护 (连续失败5次冷却30秒)
- **悬停翻译** — 按住 Alt 键悬停文字，显示浮动翻译 (150ms 节流)
- **选中翻译** — 选中文字后弹出翻译窗口，支持复制和关闭
- **域名规则** — 支持为特定域名设置"始终翻译"或"永不翻译"
- **键盘快捷键** — `Alt+T` 开关翻译, `Alt+H` 开关悬停, `Alt+S` 翻译选中文本
- **SPA 支持** — MutationObserver 防抖批量扫描动态内容，视口感知即时入队

## 效果预览

![插件弹窗](https://via.placeholder.com/400x300/1a1a2e/e0e0ff?text=Popup+UI)
![页面翻译](https://via.placeholder.com/400x300/0d1117/c9d1d9?text=Page+Translation)

## 安装

### 开发者模式安装

1. 克隆仓库或从 [Release 页面](https://github.com/aliiy/trans-plug/releases) 下载最新版本
2. 打开 Chrome，访问 `chrome://extensions`
3. 启用右上角"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择项目的 `dist/` 目录

### 从 Chrome Web Store 安装

> 即将上架，敬请期待。

## 使用方法

1. 点击浏览器工具栏的扩展图标，打开弹窗
2. 输入你的 **DeepSeek API Key**（从 [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) 获取）
3. 开启"页面翻译"开关
4. 浏览任意英文/日文网页，翻译会自动显示在原文下方

### 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt+T` | 启用/禁用页面翻译 |
| `Alt+H` | 启用/禁用悬停翻译 |
| `Alt+S` | 翻译当前选中文本 |

### 域名规则

在弹窗中可以为当前域名设置规则：
- **默认** — 跟随全局开关
- **始终翻译** — 即使全局关闭，此域名仍然翻译
- **永不翻译** — 即使全局开启，此域名也不翻译

支持通配符匹配，如 `*.example.com` 匹配所有子域名。

## 开发

### 环境要求

- Node.js >= 18
- npm

### 本地构建

```bash
npm install
npm run build     # 构建到 dist/
```

构建后，在 Chrome 扩展管理页面加载 `dist/` 目录即可。

### 技术栈

- **TypeScript 5** — 类型安全
- **Vite 5** — 程序化 API 构建 (build.mjs)
- **Chrome Extension Manifest V3** — 最新扩展标准
- **DeepSeek API** — deepseek-v4-flash 模型
- **Tailwind CSS 3** — 弹窗 UI 样式

## 架构

```
src/
  manifest.json              # MV3 清单：权限、content_scripts、background、commands
  content/
    index.ts                 # 主控制器：IntersectionObserver + MutationObserver + 翻译队列
    hover-translator.ts      # 悬停翻译：Alt+悬停 → 浮动工具提示
    selection-translator.ts  # 选中翻译：选中文本 → 弹出翻译窗口
    styles.ts                # 所有注入 CSS（<style> 元素注入，永不使用 innerHTML）
  popup/
    index.html               # 弹窗 UI：毛玻璃深色主题
    index.ts                 # 弹窗逻辑：chrome.storage 同步 + chrome.tabs.sendMessage
    popup.css                # 弹窗样式
  background/
    index.ts                 # Service Worker：键盘快捷键 + 右键菜单
  utils/
    storage.ts               # chrome.storage.local 类型安全封装
    cache.ts                 # 内容哈希缓存 (djb2 → chrome.storage.local)
    domUtils.ts              # 元素扫描 (TreeWalker)、过滤、安全 DOM 创建
    translator.ts            # DeepSeek API 客户端
    domainRules.ts           # 域名规则（始终/永不/默认 + 通配符支持）
```

### 渲染方式

翻译块作为 `<span class="imm-trans-block">` 插入在原文元素的**后面**（兄弟节点），而非内部（子节点）。这种方式：

- ✅ 不修改原文元素的内部 DOM 结构，不影响 React/Vue 的协调机制
- ✅ 不破坏原文元素子节点的 CSS `:nth-child` / `:last-child` 选择器
- ✅ 翻译在父元素的 `overflow:hidden` 区域之外，无需修改页面截断样式
- ✅ 原文元素的自身布局（flex/grid 项目）保持不变

### 数据流

```
Popup ──chrome.tabs.sendMessage──→ Content Script
Background (commands/contextMenu) ──chrome.tabs.sendMessage──→ Content Script
Content Script ←──chrome.storage.local──→ Popup (设置持久化)
```

### 翻译流程

1. `IntersectionObserver` 监测页面中的可翻译元素（rootMargin: 300px）
2. 元素进入视口附近时加入翻译队列（`Set<Element>` 去重）
3. 200ms 防抖后，每批最多 15 个元素调用 DeepSeek API
4. 先查缓存（`chrome.storage.local`），命中直接渲染，未命中调用 API
5. 翻译结果缓存并渲染为兄弟 `<span>` 元素

### 元素过滤规则

- **翻译**: `P`, `LI`, `H1-H6`, `BLOCKQUOTE`, `FIGCAPTION`, `DD`, `DT` — 始终翻译
- **翻译(叶节点)**: `DIV`, `ARTICLE`, `SECTION`, `TD`, `TH`, `SUMMARY`, `LABEL`, `LEGEND`, `OPTION` — 仅无块级子元素时翻译
- **跳过**: `VIDEO`, `AUDIO`, `CANVAS`, `SVG`, `CODE`, `PRE`, `SCRIPT`, `STYLE`, `IFRAME`, `TEXTAREA`, `INPUT`, `SELECT`, `BUTTON`, 代码块容器, `role="button"`, `contenteditable="true"`, 带 `data-imm-skip` 的元素
- **语义跳过**: `<nav>`, `<footer>`, `<aside>` 及其内部元素; UI chrome class (nav/sidebar/breadcrumb/toolbar 等，词边界正则匹配); fixed/sticky 顶部导航
- **模式跳过**: 纯数字/日期/金额, @提及, #标签, 单字UI标签(Login, Submit...), 纯emoji, ≤5字符全大写缩写
- 文本长度 < 2 个字符的元素也会被跳过

## API 配置

### DeepSeek API

| 参数 | 值 |
|------|-----|
| 端点 | `https://api.deepseek.com/v1/chat/completions` |
| 模型 | `deepseek-v4-flash` |
| 温度 | `0.3` |
| 最大 Token | `4096` |
| 流式 | 否 |

系统提示词自动检测源语言（英语/日语），翻译为简体中文，数字、URL、代码、中文保持不变。

### 缓存

- 哈希算法：djb2 变体 (32-bit)
- 缓存 Key 前缀：`tx_`
- 存储位置：`chrome.storage.local`
- 批量查询：一次查询多个哈希，减少 I/O

## 常见问题

### Q: 为什么某些元素没有被翻译？

插件会自动跳过以下元素：
- 代码块 (`CODE`, `PRE`) 和包含代码相关 CSS 类的容器
- 交互式元素（按钮、输入框、`contenteditable`）
- 已翻译的元素（通过 `data-imm-hash` 属性标记）
- 文本长度小于 2 个字符的元素
- 包含块级子元素的布局容器（避免与子元素翻译重复）

### Q: API Key 安全吗？

API Key 仅存储在浏览器本地的 `chrome.storage.local` 中，**不会**发送到除 DeepSeek 官方 API 以外的任何服务器。插件的 Service Worker 和 Content Script 都在浏览器沙箱中运行，网页 JavaScript 无法访问你的 API Key。

### Q: 支持哪些浏览器？

支持所有基于 Chromium 内核的浏览器（Chrome、Edge、Brave、Arc 等）。Firefox 暂不支持（Manifest V3 兼容性）。

### Q: 翻译结果不准确怎么办？

翻译质量取决于 DeepSeek API 的模型能力。你可以尝试：
- 确保 API Key 有效且有足够的额度
- 检查网络连接是否正常
- 复杂专业术语可能需要手动参考

### Q: 如何清除翻译缓存？

在弹窗中点击"清除缓存"按钮即可清除所有已缓存的翻译结果。下次翻译时会重新调用 API。

## License

MIT
