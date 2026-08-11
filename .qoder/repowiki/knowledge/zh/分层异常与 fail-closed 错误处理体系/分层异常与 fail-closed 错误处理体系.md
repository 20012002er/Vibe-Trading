---
kind: error_handling
name: 分层异常与 fail-closed 错误处理体系
category: error_handling
scope:
    - '**'
source_files:
    - agent/backtest/loaders/base.py
    - agent/src/factors/registry.py
    - agent/src/live/enforcement.py
    - agent/api_server.py
    - agent/src/api/alpha_routes.py
    - agent/src/api/live_routes.py
    - agent/src/api/helpers.py
    - agent/backtest/constraints.py
    - agent/backtest/correlation.py
    - agent/backtest/engines/base.py
---

## 1. 总体方案

仓库没有统一的 `errors/` 包或全局异常基类，而是按领域分层定义异常：
- **业务/策略层**：自定义 `Exception` 子类（如 `NoAvailableSourceError`、`RegistryError`、`SkipAlpha`、`UniverseDataUnavailable`），用于表达可被上层捕获并转换的语义化错误。
- **参数/校验层**：直接使用 Python 标准异常 `ValueError`、`KeyError`、`RuntimeError`、`TimeoutError`，通过带上下文的消息传递上下文信息。
- **HTTP 层**：FastAPI 路由直接 `raise HTTPException(status_code=..., detail=...)`，由 FastAPI/Starlette 默认异常处理器统一转成 JSON 响应；未注册全局 `@app.exception_handler`，依赖框架默认行为。
- **外部 I/O 层**：通过共享工具 `retry_with_budget` + `check_budget` 对声明式 transient 异常做有界重试，最终统一包装为 `TimeoutError` 并保留 `__cause__`。

## 2. 关键文件与位置

| 层次 | 关键文件 | 职责 |
|---|---|---|
| 数据加载器边界 | `agent/backtest/loaders/base.py` | 定义 `NoAvailableSourceError`、OHLC 校验、`validate_date_range`、`check_budget`、`retry_with_budget`（带 backoff `(0.5, 1.5, 4.0)` 和默认 `max_retries=3`） |
| Alpha 注册表 | `agent/src/factors/registry.py` | 定义 `SkipAlpha`（跳过因子）、`RegistryError`（配置/导入/计算失败）、`_LoadError` 记录扫描期错误；AST 解析 `__alpha_meta__` 时把 `ValidationError` 包装为 `RegistryError` |
| 实盘指令约束 | `agent/src/live/enforcement.py` | 定义 `UniverseDataUnavailable`、`OrderIntent`、`BreachEvent`；`check_mandate` 采用“fail-closed”顺序检查（exclude-list → instrument → asset-class → notional → exposure → leverage → daily count → funding），任何不可解析输入返回 DENY |
| API 路由 | `agent/src/api/*.py`（如 `alpha_routes.py`、`live_routes.py`、`helpers.py`） | 在路由内直接 `raise HTTPException(...)`，用 `_safe_error(exc)` 等辅助函数脱敏后放入 `detail` |
| 服务器入口 | `agent/api_server.py` | SPA 静态文件路由中捕获 `StarletteHTTPException`，仅对 404 降级到 `index.html`；安装访问日志脱敏过滤器 |
| 其他领域异常 | `agent/src/channels/matrix.py`（`_MediaTooLargeError`）、`agent/backtest/loaders/rsshub_events.py`（`EventProviderError`）、`agent/backtest/loaders/tushare_fundamentals.py`（`DataProviderError`） | 各子域局部异常 |

## 3. 架构与约定

### 3.1 重试与预算（backload 层）
- 所有调用不稳定外部 API 的 loader 必须使用 `retry_with_budget(fn, transient=..., deadline=..., label=..., max_retries=DEFAULT_MAX_RETRIES, backoff=DEFAULT_BACKOFF)`。
- 非 `transient` 异常立即原样抛出，不被重试；耗尽重试或超时后统一以 `TimeoutError(f"{label} failed after N attempt(s): {exc}") from exc` 形式抛出。
- `check_budget(deadline, label, budget_s)` 在分页循环间调用，超时就抛 `TimeoutError`，避免长时间挂起。

### 3.2 数据完整性校验
- `validate_date_range`、`validate_ohlc`、`validate_columns_required` 等函数集中做入参校验，失败抛 `ValueError`，消息包含字段名与期望值。
- OHLC 校验支持三种策略：`"drop"`（默认，丢弃无效 K 线）、`"warn"`（记录警告并放行）、`"raise"`（严格模式）。`allow_nonpositive_prices` 控制是否允许负价格（欧洲电力市场场景）。

### 3.3 因子注册表容错
- `_scan()` / `_try_register()` 捕获 `RegistryError` 并追加到 `_load_errors`，不会中断整个 zoo 扫描。
- `health()` 暴露 `{loaded, failed, errors}` 供监控。
- `compute()` 对 import 和 compute 两个阶段分别 try/except，统一包装为 `RegistryError`，并对输出做 shape、inf、NaN ratio >95% 的校验。

### 3.4 实盘强制约束（fail-closed）
- `check_mandate` 文档明确“every check is fail-closed: any unparseable input, missing market data, or ambiguous field denies the order rather than waving it through”。
- 违反分为三类：`universe` / `instrument`（结构违规，直接 DENY）、`quantitative`（数值越界，PAUSE_FOR_REAUTH）。
- 缺失行情数据时返回 `None`（DENY）而非放行；`UniverseDataUnavailable` 作为“无可用数据源”的信号向上冒泡。

### 3.5 HTTP 错误
- 路由层直接 `raise HTTPException(status_code=..., detail=...)`，例如 400（参数非法）、404（资源不存在）、500（内部错误）。
- 未注册全局异常处理器，依赖 FastAPI 默认行为；SPA 静态路由单独处理 404 重定向到 `index.html`。

## 4. 约定与约束

| 约定 | 说明 | 依据 |
|---|---|---|
| 外部 I/O 必须走 `retry_with_budget` | 新 loader 应复用该工具，而不是自行实现重试循环 | `base.py` 模块 docstring：“New loaders should import ... retry_with_budget rather than re-implementing the loop.” |
| 瞬态异常需显式声明 | 只有传入 `transient` 的异常类才会被重试，其它异常立即上抛 | `retry_with_budget` 逻辑 |
| 回测/因子输入校验抛 `ValueError` | 参数不合法时使用标准异常，消息包含具体字段 | `constraints.py`、`correlation.py`、`engines/base.py` 多处一致用法 |
| 注册表级错误用 `RegistryError` | AST 解析、import、compute 失败统一包装 | `registry.py` 多处 `raise RegistryError(...)` |
| 因子前置条件不满足抛 `SkipAlpha` | 表示“跳过此因子”，不是致命错误 | `registry.py` 中 `columns_required` / `extras_required` / `requires_sector` 检查 |
| 实盘约束 fail-closed | 任何不可解析输入、缺失数据都拒绝订单 | `enforcement.py` 模块 docstring 及 `check_mandate` 实现 |
| 量化交易相关错误优先用结构化 `BreachEvent` | 携带 `broker`、`limit`、`limit_value`、`attempted_value`、`overage`、`kind` 等字段 | `enforcement.py` 的 `_breach` 构造器 |
| HTTP 错误用 `HTTPException` | 路由层直接 raise，状态码与 detail 描述原因 | `src/api/*.py` 中的多处 raise |