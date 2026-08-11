---
kind: build_system
name: 多语言构建与容器化发布体系（Python/Node/Electron/Docker/CI）
category: build_system
scope:
    - '**'
source_files:
    - pyproject.toml
    - requirements-lock.txt
    - Dockerfile
    - docker-compose.yml
    - frontend/package.json
    - desktop/electron/package.json
    - .github/workflows/test.yml
    - .github/workflows/desktop-windows.yml
    - .github/workflows/wiki-deploy.yml
    - tools/ci_grep_gates.sh
---

## 1. 使用的系统与工具

- **Python 包管理**：基于 `pyproject.toml`（setuptools），通过 `pip install -e .` 安装；依赖锁定使用 `requirements-lock.txt`，以 `--require-hashes` 强制校验。
- **前端构建**：`frontend/` 使用 Vite + TypeScript + Tailwind，脚本为 `npm run build`（先 `tsc -b` 再 `vite build`），测试用 Vitest。
- **桌面端打包**：`desktop/electron/` 使用 Electron 43 + electron-builder 26，通过 `npm run pack:win` 生成 NSIS 安装包，产物命名含版本与架构。
- **容器化**：根目录 `Dockerfile` 采用三阶段构建（`frontend-build` → `builder` → `runtime`），运行时镜像仅携带预编译 venv 与静态资源，不保留编译器。
- **编排**：`docker-compose.yml` 提供 `vibe-trading`（后端+前端静态）和可选的 `frontend`（热重载开发服务）两个 service，并声明只读根文件系统、tmpfs、内存/CPU/PID 限制等安全加固项。
- **CI/CD**：GitHub Actions 定义在 `.github/workflows/`：
  - `test.yml`：Linux 上运行 Python 3.11 单元测试、前端构建与测试、Windows 后台进程回归、Electron 桌面生命周期冒烟测试。
  - `desktop-windows.yml`：在 Windows Server 2022 上构建 NSIS 安装包并输出 SHA-256 校验文件。
  - `wiki-deploy.yml`：将 `wiki/` 通过 Cloudflare Wrangler 部署到 Pages。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `pyproject.toml` | Python 包元数据、入口点 (`vibe-trading`, `vibe-trading-mcp`)、可选 extras、pytest/ruff/coverage 配置 |
| `requirements-lock.txt` | 哈希锁定的 Python 依赖清单，CI 与 Docker builder 均据此安装 |
| `Dockerfile` | 三阶段构建镜像，暴露 8899 端口，默认执行 `vibe-trading serve --host 0.0.0.0 --port 8899` |
| `docker-compose.yml` | 本地开发/部署编排，挂载 runs/sessions/uploads/home 卷，限制资源并启用 read_only 根文件系统 |
| `frontend/package.json` | Vite/Tailwind/Vitest 脚本与依赖 |
| `desktop/electron/package.json` | Electron 应用脚本、electron-builder 配置（NSIS 目标、asar、extraResources） |
| `.github/workflows/test.yml` | 主 CI 流水线（Python + Node + Desktop smoke） |
| `.github/workflows/desktop-windows.yml` | Windows 桌面打包流水线 |
| `.github/workflows/wiki-deploy.yml` | Wiki 站点 Cloudflare Pages 部署 |
| `tools/ci_grep_gates.sh` | CI 代码安全门禁（grep 规则禁止 unsafe yaml.load、商标词、敏感信息泄露等） |

## 3. 架构与约定

- **分层镜像**：`builder` 阶段安装 `build-essential` 编译 wheel 并创建 `/opt/venv`；`runtime` 阶段仅复制该 venv 及必要的共享库（weasyprint PDF 渲染所需 Pango/HarfBuzz/Cairo 等），体积最小化。
- **可编辑安装**：`pip install -e .` 使运行时仍指向源码树，便于调试；同时把 `agent/src/**`、`backtest/**`、`cli*` 以及 skills/templates 等作为 package-data 打包。
- **前端资源内嵌**：Docker 构建时先在 `frontend-build` 阶段 `npm run build` 产出 `dist/`，再复制到 runtime 镜像中，由 API server 作为静态文件提供。
- **非 root 运行**：镜像创建 `vibe` 用户与 `vibe-sandbox` 系统账户，`runner.py` 以 sandbox 用户执行 LLM 生成的子进程；Compose 层进一步启用 `read_only`、`cap_drop: ALL`、`no-new-privileges`。
- **版本同步**：Python 包版本与前端版本均在各自 `package.json` / `pyproject.toml` 中维护（当前均为 `0.1.13`），Docker image label 也显式标注。
- **可选依赖拆分**：通过 `[project.optional-dependencies]` 按功能域（`ibkr`, `longbridge`, `mt5`, `stats`, `channels`, `dev` 等）切分，基础安装保持精简，按需启用。

## 4. 约定与约束

- **依赖必须哈希锁定**：CI 步骤 `Verify hash-locked dependencies` 以 `--dry-run --require-hashes` 验证 `requirements-lock.txt`，任何未加哈希的依赖都会导致构建失败。
- **Python 版本范围受控**：`requires-python = ">=3.11,<3.14"`，CI 主任务固定 3.11，Windows 背景回归使用 3.14，Docker 镜像基于 `python:3.11-slim`。
- **Node 版本固定**：Docker 使用 `node:22-slim`，CI 使用 `actions/setup-node@... node-version: "22"`，`frontend/package.json` 的 `engines.node >= 22.22.0`。
- **测试路径与标记**：pytest 配置 `testpaths = ["agent/tests"]`，区分 `unit` 与 `integration` marker；CI 显式 `--ignore=agent/tests/e2e_backtest` 与 `test_e2e_harness_v2.py`，避免误跑真实 LLM 调用。
- **覆盖率统计范围**：`tool.coverage.run.source = ["agent"]`，排除 tests 与 `__init__.py`。
- **Lint 规则**：Ruff target py311，行宽 120，仅启用 E/F/W 规则，忽略 E501；alpha zoo 文件豁免 F401。
- **桌面端产物命名**：electron-builder 输出 `Vibe-Trading-Desktop-Unofficial-${version}-${arch}.${ext}`，CI 会计算并写入 `release/SHA256SUMS.txt`。
- **Wiki 部署触发**：仅当 `wiki/**` 或对应 workflow 变更时触发，通过 `wrangler pages deploy` 从 `wiki/` 工作目录部署，确保 Functions 被正确编译而非当作静态文件上传。