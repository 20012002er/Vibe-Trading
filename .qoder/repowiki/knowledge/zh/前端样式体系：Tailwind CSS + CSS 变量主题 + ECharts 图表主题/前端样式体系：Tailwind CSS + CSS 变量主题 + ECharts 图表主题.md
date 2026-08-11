---
kind: frontend_style
name: 前端样式体系：Tailwind CSS + CSS 变量主题 + ECharts 图表主题
category: frontend_style
scope:
    - '**'
source_files:
    - frontend/tailwind.config.ts
    - frontend/postcss.config.js
    - frontend/src/index.css
    - frontend/public/theme-boot.js
    - frontend/src/hooks/useDarkMode.ts
    - frontend/src/lib/theme-store.ts
    - frontend/src/lib/chart-theme.ts
    - frontend/package.json
---

## 1. 采用的系统与方法

Vibe-Trading 的前端（`frontend/`）采用 **Vite + React + TypeScript** 工程，样式体系以 **Tailwind CSS v3** 为核心原子化框架，通过 PostCSS + Autoprefixer 构建。深色模式使用 Tailwind 的 `darkMode: "class"` 策略，由 `<html>` 上的 `.dark` 类控制。

- **设计令牌层**：所有颜色、圆角等视觉变量均通过 CSS Custom Properties（`--background`、`--foreground`、`--primary`、`--success`、`--danger`、`--warning`、`--info`、`--chart-grid` 等）在 `src/index.css` 中声明，Light/Dark 两套值分别定义在 `:root` 与 `.dark` 选择器下。
- **Tailwind 扩展**：`tailwind.config.ts` 通过 `theme.extend.colors` 将 HSL 变量映射到语义色名（`border`、`background`、`foreground`、`muted`、`primary`、`destructive`、`card`、`popover`、`success`、`danger`、`warning`、`info`），并通过 `fontFamily` 和 `borderRadius` 扩展字体与圆角。
- **排版插件**：引入 `@tailwindcss/typography` 用于 Markdown 渲染的 prose 样式。
- **组件库**：未引入 UI 组件库（如 shadcn/ui），样式完全基于 Tailwind 原子类；图标使用 `lucide-react`，通知使用 `sonner`，状态管理使用 `zustand`。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `frontend/tailwind.config.ts` | Tailwind 配置，定义 darkMode、colors/fontFamily/borderRadius 扩展及 typography 插件 |
| `frontend/postcss.config.js` | PostCSS 管线（tailwindcss → autoprefixer） |
| `frontend/src/index.css` | 全局样式入口，声明全部 CSS 变量（light/dark）、base 层样式、滚动条、RTL 镜像、动画 |
| `frontend/public/theme-boot.js` | 首屏无闪烁脚本，在 HTML 加载时立即设置 `documentElement.classList` 为 `dark`/`light`，避免 FOUC |
| `frontend/src/hooks/useDarkMode.ts` | React Hook，维护 `qa-theme` 本地存储、监听系统偏好变化、同步 `.dark` 类并广播主题变更 |
| `frontend/src/lib/theme-store.ts` | 单例主题 store，通过 `useSyncExternalStore` 暴露 `isDarkTheme`/`subscribeTheme`/`publishThemeChange` |
| `frontend/src/lib/chart-theme.ts` | 将 CSS 变量读入 ECharts 主题对象，支持中英文 K 线涨跌色反转（中国红涨绿跌） |
| `frontend/package.json` | 依赖声明（tailwindcss、autoprefixer、echarts、i18next、lucide-react、sonner、zustand 等） |

## 3. 架构与设计约定

### 主题切换流程
1. `public/theme-boot.js` 在 `<head>` 中执行，读取 `localStorage["qa-theme"]`，若未保存则回退到 `prefers-color-scheme`，立即给 `<html>` 加上或移除 `.dark` 类并设置 `colorScheme`。
2. React 启动后 `useDarkMode` hook 初始化状态，后续切换时写入 `qa-theme`、更新 DOM 类名，并调用 `publishThemeChange()` 通知订阅者。
3. `theme-store.ts` 提供跨组件的主题订阅能力，ECharts、代码高亮等需要响应主题变化的第三方库通过 `subscribeTheme` 重新渲染。

### 颜色与语义层
- 所有颜色以 HSL 形式定义在 CSS 变量中，Tailwind 通过 `hsl(var(--xxx))` 引用，确保任意工具链均可解析。
- 语义色分为四类：基础表面（background/card/popover/muted）、品牌（primary）、反馈（success/danger/warning/info）、边框（border）。注释明确说明 popover 必须是不透明表面，防止下拉菜单透出底层内容。
- 深色模式采用“4 级表面系统”，相邻层级保持 ≥5% 明度差，保证侧边栏与主面板可区分。

### 图表主题
- `chart-theme.ts` 从 `getComputedStyle(document.documentElement)` 读取 CSS 变量，转换为 hex 后注入 ECharts 配置。
- 根据 `navigator.language` 是否以 `zh` 开头自动切换 K 线涨跌色（中文环境红涨绿跌，英文环境绿涨红跌）。
- 缓存主题对象，键为 `className|lang`，避免重复计算。

### 组件样式约定
- 组件内直接使用 Tailwind 原子类（`className="..."`），未见 SCSS/CSS Modules 文件。
- 通过 `clsx` 与 `tailwind-merge` 组合条件类名（见 package.json 依赖）。
- 表格样式通过 `prose table` 增强，偶数行带半透明 muted 背景。
- 自定义动画集中在 `index.css`（`pulse-slide`、`msg-enter`），并尊重 `prefers-reduced-motion`。
- RTL 支持：通过 `[dir="rtl"] .rtl\:flip-x` 镜像方向性图标。

## 4. 约定与约束

- **深色模式开关方式**：统一通过给 `<html>` 添加/移除 `.dark` 类实现，禁止在组件内直接操作 `document.body` 或覆盖 CSS 变量。
- **主题持久化键名**：固定为 `qa-theme`，值为字符串 `"dark"` / `"light"`，由 `useDarkMode` 与 `theme-boot.js` 共同读写。
- **颜色来源**：新增视觉颜色必须先在 `src/index.css` 的 `:root` 与 `.dark` 下成对声明 CSS 变量，再在 `tailwind.config.ts` 的 `theme.extend.colors` 中注册语义别名，禁止硬编码十六进制色值。
- **图表颜色**：所有 ECharts 实例必须通过 `getChartTheme()` 获取主题对象，不得自行定义配色。
- **字体栈**：正文使用 Inter + system-ui，数字/代码使用 JetBrains Mono + ui-monospace，标题/问候语使用 Georgia/Songti SC/Noto Serif SC 堆栈。
- **无障碍**：所有自定义动画需包裹 `@media (prefers-reduced-motion: reduce)` 禁用分支。
- **国际化影响样式**：图表涨跌色、tooltip 文本等根据 `navigator.language` 动态调整，新增语言需考虑 K 线涨跌约定。
- **构建产物**：PostCSS 仅启用 tailwindcss 与 autoprefixer，不引入其他预处理步骤，确保样式体积最小化。