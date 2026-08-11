---
kind: logging_system
name: 基于 Python logging 的分散式日志系统（含 Uvicorn 访问日志脱敏）
category: logging_system
scope:
    - '**'
source_files:
    - agent/api_server.py
    - agent/src/api/security.py
    - agent/src/channelsui/websocket_logging.py
    - agent/scripts/w4a_run_benches.py
    - agent/backtest/loaders/base.py
    - agent/backtest/engines/base.py
---

## 1. 使用的系统与框架

仓库采用 Python 标准库 `logging` 作为统一的日志框架，未引入第三方日志库（如 loguru、structlog）。所有模块通过 `import logging` 后调用 `logging.getLogger(__name__)` 获取命名 logger，遵循 Python 社区推荐的“每个模块一个 logger”模式。CLI 交互输出则使用 Rich 的 `Console`（`console.print(...)`），与结构化日志分离。

## 2. 关键文件与位置

- **API 服务入口**：`agent/api_server.py` — 创建 FastAPI 应用，导入并调用 `install_access_log_redaction_filter()`，在启动时挂载到 Uvicorn 的 access/error logger。
- **安全/脱敏逻辑**：`agent/src/api/security.py` — 定义 `_AccessLogRedactionFilter` 过滤器和 `install_access_log_redaction_filter()`，对 `uvicorn.access`、`uvicorn.error`、`uvicorn` 三个 logger 附加过滤函数，实现 URL query 中的敏感参数（如 API key、ticket）自动脱敏。
- **WebSocket 专用 logger**：`agent/src/channelsui/websocket_logging.py` — 仅声明 `websockets_server_logger = logging.getLogger("src.channelsui.websocket")`，为 WebSocket 通道适配器提供独立命名空间。
- **基准脚本**：`agent/scripts/w4a_run_benches.py` — 唯一显式调用 `logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")` 的位置，用于 CLI 基准运行时的根 handler 配置。
- **业务模块**：大量 backtest loader/engine 模块（如 `agent/backtest/loaders/base.py`、`agent/backtest/engines/base.py`、`agent/backtest/correlation.py` 等）均按 `logger = logging.getLogger(__name__)` + `logger.warning/debug(...)` 模式记录数据校验、缓存读写等事件。

## 3. 架构与约定

- **无集中式日志初始化**：除 `w4a_run_benches.py` 外，没有全局的 `basicConfig` 或 `logging.config.dictConfig`；各进程/入口自行决定 handler 与格式。FastAPI/Uvicorn 运行时依赖其默认 stderr handler，并通过 `install_access_log_redaction_filter()` 注入安全过滤。
- **命名空间策略**：logger 名称即模块路径（`__name__`），便于按包层级控制级别（例如 `src.channelsui.websocket` 单独暴露给 WebSocket 相关代码）。
- **结构化字段**：未使用 JSON 结构化日志；消息以格式化字符串拼接，字段通过 `%s`/`%r` 占位符嵌入（如 `logger.warning("OHLC validation: %d bar(s) violate invariants (kept)", n_invalid)`）。
- **级别使用**：业务模块普遍使用 `logger.debug`（如缓存 dtype 恢复跳过）、`logger.warning`（数据校验失败、缓存读写异常）；未发现 `logger.error`/`exception` 的大规模使用，错误通常以异常形式向上抛出。
- **CLI 输出与日志分离**：交互式 REPL 通过 Rich `Console` 直接打印彩色终端输出，不混入 `logging` 流，避免与后台服务的日志混杂。

## 4. 约定与约束

- **每个模块必须用 `logging.getLogger(__name__)` 获取 logger**：这是仓库中所有业务模块的一致做法，未见直接使用 `print` 或 `logging.info` 的散点调用。
- **Uvicorn 访问日志强制脱敏**：`api_server.py` 在启动时调用 `install_access_log_redaction_filter()`，该函数对 `uvicorn.access`、`uvicorn.error`、`uvicorn` 三个 logger 添加 `_AccessLogRedactionFilter`，且通过检查已存在 filter 保证幂等（重复安装不会叠加）。测试 `test_sse_ticket_and_headers.py::test_install_access_log_redaction_filter_is_idempotent` 验证了此行为。
- **SSE ticket 不在 URL 中泄露**：安全模块通过一次性 ticket 机制避免将长生命周期 API key 放入 EventSource URL，从而降低被日志捕获的风险。
- **日志格式由入口进程决定**：只有 `w4a_run_benches.py` 显式设置 `format="%(asctime)s %(levelname)s %(name)s | %(message)s"`；其他场景依赖各自宿主（Uvicorn 默认、Rich Console）的格式，不存在仓库级统一格式规范。
- **未启用文件 sink**：仓库中没有发现 `FileHandler`、`RotatingFileHandler` 或任何将日志写入磁盘的配置；日志输出目标为 stdout/stderr（由容器/进程管理器收集）。
- **未使用异步日志器**：全部基于同步 `logging`，无 `aiologger`、`loguru.asyncio` 等异步适配。

## 5. 总结

该仓库的日志系统是轻量级的：以 Python 标准库 `logging` 为基础，按模块分散声明 logger，通过 FastAPI/Uvicorn 启动流程注入安全脱敏过滤器，CLI 交互走 Rich Console 独立输出。没有集中式配置文件、没有结构化 JSON 日志、没有文件 sink，属于典型的“开发/本地部署友好”风格，适合容器化环境下由外部日志采集器处理。