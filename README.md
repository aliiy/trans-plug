# 沉浸式翻译 (Immersive Translation)

基于 DeepSeek API 的 Chrome/Edge 浏览器插件 (Manifest V3)。自动识别网页中的**英语 / 日语 / 俄语**等外语，在原文下方插入简体中文翻译，并支持悬停翻译、划词翻译与按域名开关。

## 功能

- **页面翻译** — 滚动时优先翻译可见区域，原文下方插入译文，不破坏页面布局
- **悬停翻译** — 按住 `Alt` 悬停文字即时翻译
- **划词翻译** — 选中文本弹出译文，可一键复制
- **多语言** — 自动检测英 / 日 / 俄 / 韩等语言 → 简体中文
- **智能过滤** — 跳过导航 / 页脚 / 代码块 / 按钮等非正文内容
- **缓存与可靠性** — 本地哈希缓存（7 天 TTL）+ 重试与熔断保护
- **域名规则** — 为指定站点设「始终 / 永不翻译」，支持 `*.example.com` 通配符

## 安装

1. 下载 [最新 Release](https://github.com/aliiy/trans-plug/releases) 或自行构建（见下）
2. 打开 `chrome://extensions` → 开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」→ 选择 `dist/` 目录

## 使用

1. 点击工具栏扩展图标，填入 **DeepSeek API Key**（[获取](https://platform.deepseek.com/api_keys)）
2. 打开「页面翻译」开关，浏览任意外文网页即可自动翻译

| 快捷键 | 功能 |
|--------|------|
| `Alt+T` | 开关页面翻译 |
| `Alt+H` | 开关悬停翻译 |
| `Alt+S` | 翻译选中文本 |

> API Key 仅保存在本地 `chrome.storage.local`，只发往 DeepSeek 官方 API，不经过任何第三方。

## 构建

```bash
npm install
npm run build   # 输出到 dist/
```

技术栈：TypeScript 5 · Vite 5 · Manifest V3 · Tailwind CSS 3 · DeepSeek `deepseek-v4-flash`。

> 架构与实现细节见 [`CLAUDE.md`](./CLAUDE.md)。

## License

MIT
