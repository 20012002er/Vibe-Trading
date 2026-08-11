---
kind: dependency_management
name: 多语言依赖管理：pip + npm 双栈与锁定文件、可选依赖与 Dependabot 治理
category: dependency_management
scope:
    - '**'
source_files:
    - pyproject.toml
    - agent/requirements.txt
    - requirements-lock.txt
    - frontend/package.json
    - frontend/package-lock.json
    - desktop/electron/package.json
    - desktop/electron/package-lock.json
    - .github/dependabot.yml
---

## 1. 使用的系统/方法

仓库采用**多语言、分目录**的依赖管理策略，每个子工程各自维护独立的包清单与锁文件：

- **Python（核心 Agent / CLI / API）**：使用 `pyproject.toml`（PEP 621）声明项目元数据与依赖，同时保留 `agent/requirements.txt` 作为人类可读的依赖清单；通过 `pip-compile`（`pip-tools`）生成带 SHA256 hash 的 `requirements-lock.txt`，用于可重复安装。
- **前端（Vite + React + TypeScript）**：使用 `frontend/package.json` 声明依赖，配合 `frontend/package-lock.json` 锁定精确版本。
- **Electron 桌面宿主**：使用 `desktop/electron/package.json` 声明依赖，配合 `desktop/electron/package-lock.json` 锁定。
- **自动更新**：通过 `.github/dependabot.yml` 对 pip、npm 和 GitHub Actions 三类生态配置月度扫描与分组 PR。

没有发现 Go 模块（无 `go.mod`）、Ruby Gemfile、Cargo 等其它语言的依赖声明。所有第三方库均从公共 PyPI/npm 获取，未发现私有 registry 或 vendoring 目录。

## 2. 关键文件

| 作用 | 路径 |
|---|---|
| Python 项目清单（含可选依赖 extras） | `pyproject.toml` |
| Python 人类可读依赖清单 | `agent/requirements.txt` |
| Python 确定性锁文件（含哈希） | `requirements-lock.txt` |
| 前端依赖清单 | `frontend/package.json` |
| 前端锁文件 | `frontend/package-lock.json` |
| Electron 桌面依赖清单 | `desktop/electron/package.json` |
| Electron 锁文件 | `desktop/electron/package-lock.json` |
| Dependabot 规则 | `.github/dependabot.yml` |
| Docker 构建入口 | `Dockerfile`（引用 `requirements-lock.txt`） |

## 3. 架构与约定

### 3.1 Python 依赖分层

- **核心依赖**集中在 `pyproject.toml` 的 `[project].dependencies` 中（如 langchain、fastapi、pandas、ccxt、yfinance、akshare 等），并通过 `requires-python = ">=3.11,<3.14"` 限定解释器范围。
- **可选依赖**通过 `[project.optional-dependencies]` 以 extras 形式提供，例如 `ibkr`、`longbridge`、`mt5`、`deepseek`、`anthropic`、`openbb`、`stats`、`ashare`、`harmonic`、`dingtalk`、`discord`、`feishu`、`matrix`、`mochat`、`msteams`、`napcat`、`qq`、`slack`、`telegram`、`wecom`、`weixin`、`whatsapp`、`channels`、`dev` 等。代码中以“lazy-import + 抛出 actionable ImportError”的方式按需加载这些可选包，使基础安装保持精简。
- `agent/requirements.txt` 是面向用户的安装参考，注释中明确标注了各 extras 的安装方式（如 `pip install "vibe-trading-ai[deepseek]"`）。
- `pyproject.toml` 通过 `[tool.setuptools.packages.find]` 将 `agent` 目录下的 `src*`、`backtest*`、`cli*` 打包为发布包，并声明 `vibe-trading`、`vibe-trading-mcp` 两个 entry point。

### 3.2 版本约束策略

- 核心依赖普遍采用 **下限 + 上限** 的区间约束，例如 `langchain>=1.3.9,<2`、`pandas>=2.0.0,<3.0.0`、`websockets>=12.0`、`rich>=13.0.0`，避免破坏性升级。
- 在 `pyproject.toml` 的注释中显式记录上限原因（如 `llvmlite` 尚无 cp314 wheel，因此限制 `<3.14`；`smartmoneyconcepts` 因 `zigzag` 无 arm64/py3.11 wheel 而要求 ≥0.0.27）。
- 锁文件 `requirements-lock.txt` 由 `pip-compile --allow-unsafe --generate-hashes --output-file=requirements-lock.txt agent/requirements.txt` 生成，包含每个包的多个平台 SHA256 hash，确保跨环境可重现安装。

### 3.3 前端与 Electron 依赖

- `frontend/package.json` 声明 Node 引擎 `engines.node >= 22.22.0`，依赖 React 19、Vite 6、Tailwind、ECharts、i18next 等，开发依赖包含 Vitest、TypeScript、Testing Library。
- `desktop/electron/package.json` 声明 Electron 43.1.1、electron-builder 26.15.3，并通过 `build.extraResources` 将后端二进制与许可证文件打包进发行产物。
- 两者均使用 npm lockfile v3（`package-lock.json`）锁定精确版本。

### 3.4 自动化更新与忽略策略

`.github/dependabot.yml` 定义了三个生态的更新规则：

- **pip**：每月扫描根目录 `pyproject.toml`，minor/patch 更新合并为组 `pip-minor-patch`，major 更新单独提交以便人工审查。
- **npm**：每月扫描 `/frontend`，minor/patch 合并为 `npm-minor-patch`，忽略 `@vitejs/plugin-react` major 升级（peer 冲突至 vite 8）。
- **GitHub Actions**：每月扫描 workflow 文件。

Dependabot 还显式 ignore 了一批被 `ccxt==4.5.71` 精确 pin 的传递依赖（aiohappyeyeballs、aiohttp-fast-zlib、aiosignal、attrs、certifi、cffi、charset-normalizer、coincurve、frozenlist、idna、multidict、orjson、propcache、pycparser、typing-extensions、urllib3、uvloop、zlib-ng、pydantic-core），因为 ccxt 的传递闭包无法独立升级；同时 ignore pandas major 与 websockets major，以避免与现有版本上限冲突。

## 4. 约定与约束

- **Python 依赖必须同时出现在 `pyproject.toml` 与 `agent/requirements.txt`**：前者用于发布包与 pip install，后者供用户阅读与 pip-compile 生成锁文件；新增依赖需两处同步修改。
- **可选功能必须通过 extras 暴露**：不在核心 dependencies 中的包应放入 `[project.optional-dependencies]`，并在代码中以 lazy import 实现降级，保证 `pip install vibe-trading-ai` 最小化。
- **禁止直接引入未声明的运行时依赖**：`requirements-lock.txt` 由 `agent/requirements.txt` 编译而来，任何未在 requirements 中声明的导入都会导致 CI 或生产安装失败。
- **版本上限必须附注释说明原因**：`pyproject.toml` 中对 `requires-python <3.14`、`smartmoneyconcepts>=0.0.27` 等约束都附带了明确的兼容性原因注释，作为后续迁移的决策依据。
- **传递依赖的升级受上游约束控制**：对于被 ccxt、pydantic 等包精确 pin 的传递依赖，Dependabot 会主动忽略其升级 PR，升级需等待上游放宽范围或本仓库升级该上游包。
- **前端与 Electron 各自独立锁定**：`frontend/package-lock.json` 与 `desktop/electron/package-lock.json` 分别锁定，互不影响；Electron 产物通过 `extraResources` 嵌入后端，不共享 npm 依赖。
- **无 vendoring 与私有 registry**：仓库未包含 `vendor/`、`third_party/` 等 vendored 目录，也未配置 `pip.conf`、`.npmrc` 等私有源，所有依赖来自公共 PyPI 与 npm registry。
