---
kind: configuration_system
name: Vibe-Trading 配置系统：Pydantic 环境配置 + JSON/YAML 结构化 Agent 配置
category: configuration_system
scope:
    - '**'
source_files:
    - agent/src/config/env_schema.py
    - agent/src/config/loader.py
    - agent/src/config/schema.py
    - agent/src/config/accessor.py
    - agent/src/config/paths.py
    - agent/src/config/migrate.py
    - agent/src/config/limits.py
    - agent/.env.example
    - tools/ci_env_var_gate.py
---

## 1. 系统概览

Vibe-Trading 采用**双层配置架构**：
- **运行时环境变量层**（`EnvConfig`）：通过 Pydantic 模型集中声明所有 `os.environ` 变量，提供类型校验、默认值与别名解析。
- **磁盘结构化配置层**（`AgentConfig`）：从 `~/.vibe-trading/agent.json` / `agent.yaml` / `agent.yml` 加载 operator 可编辑的 MCP 服务器、通道等配置，支持运行时覆盖合并。

核心设计原则是“单一真相源”——文档注释明确说明该层替换了原先散落在 66 个文件中的 ~207 处 `os.getenv` 调用。CI 安全门禁脚本（`tools/ci_env_var_gate.py`）通过 AST 扫描禁止绕过此集中配置层直接读取环境变量，强制所有代码路径统一经过 `EnvConfig`。

## 2. 关键文件与职责

| 文件 | 职责 |
|---|---|
| `agent/src/config/env_schema.py` | 所有环境变量的 Pydantic 模型定义，按功能分组为 `LLMConfig`、`DataConfig`、`APIConfig`、`SwarmConfig`、`AgentTuningConfig`、`PathConfig`、`OcrConfig`、`MemoryConfig`，顶层由 `EnvConfig` 组合 |
| `agent/src/config/loader.py` | 磁盘配置文件加载、合并、安全清洗；支持 JSON/YAML，含 swarm 专用配置解析与 session override 安全过滤 |
| `agent/src/config/schema.py` | `AgentConfig`、`MCPServerConfig`、`ChannelsConfig` 等结构化配置模型，内置 live-broker 安全校验（拒绝通配符工具白名单）、OAuth 传输约束 |
| `agent/src/config/accessor.py` | `EnvConfig` 线程安全单例访问器（`get_env_config` / `reset_env_config`），提供 `_parse_bool`、`get_env_or` 等兼容辅助函数 |
| `agent/src/config/paths.py` | 运行时根目录解析（`VIBE_TRADING_HOME` 优先，否则 `~/.vibe-trading`），配置文件候选路径查找 |
| `agent/src/config/migrate.py` | 将旧版代码相对路径下的状态目录迁移到新的运行时根目录，原子化移动并恢复中断 |
| `agent/src/config/limits.py` | 共享常量（如 `TOOL_RESULT_LIMIT = 10_000`），避免各模块硬编码截断阈值 |
| `agent/.env.example` | 完整的环境变量清单与注释，每个字段对应 `env_schema.py` 中的一个 Pydantic 字段 |

## 3. 架构与约定

### 3.1 环境变量解析流程
`_EnvBase` 基类在构造时通过 `model_validator(mode="before")` 自动从 `os.environ` 读取字段别名（UPPER_SNAKE_CASE），对数值型字段做安全转换（解析失败则回退到默认值），布尔值通过 `_parse_env_bool` 统一接受 `"1"/"true"/"yes"/"on"` 为真、`"0"/"false"/"no"/"off"/""` 为假。`EnvConfig()` 无参实例化即完成全量读取。

### 3.2 内存系统预设开关
`MemoryConfig` 提供 `VT_MEMORY=off|on|full` 三档业务预设，并通过 `VT_MEMORY_*` 单个标志位覆盖预设基线，实现“一键启用 + 精细调优”的组合模式。

### 3.3 结构化配置加载顺序
- 主 Agent：`get_config_path()` 依次查找 `<runtime_root>/agent.json` → `agent.yaml` → `agent.yml`，不存在则返回默认 JSON 路径。
- Swarm Agent：`_resolve_swarm_agent_config_path()` 优先级为 `VIBE_TRADING_SWARM_AGENT_CONFIG` 环境变量 → `<runtime_root>/swarm-agent.json` → 回退到主 agent 配置文件 → `None`。

### 3.4 运行时覆盖与安全清洗
`merge_agent_config_overrides()` 将 session 级覆盖以递归方式合并到基础配置，并对 `mcp_servers` 做传输感知合并（切换 stdio/sse/streamableHttp 时重置不兼容字段）。`sanitize_session_overrides()` 默认剥离 `mcpServers`/`mcp_servers`（进程注入能力），除非显式设置 `ALLOW_SESSION_MCP_SERVERS=1`。

### 3.5 Live Broker 安全门
`schema.py` 中 `AgentConfig.validate_live_broker_servers()` 检测 live broker（按 config key `robinhood`/`ibkr` 或 URL host 后缀匹配），拒绝其使用 `enabled_tools=["*"]` 通配符，仅允许 IBKR 在限定 OAuth scope (`mcp.read`) 下使用通配符作为只读探测。Robinhood 提供预置的只读工具白名单种子。

### 3.6 路径与状态隔离
运行时根目录由 `VIBE_TRADING_HOME` 控制，默认 `~/.vibe-trading`，包含 `sessions/`、`runs/`、`swarm/runs/`、`uploads/`、`workspace/` 等子目录。`migrate.py` 保证历史数据从旧位置（安装目录）迁移到新位置，使用 `.migrating-*` 临时名 + 原子 rename 防止中断导致半写。

## 4. 约定与约束

- **禁止绕过集中配置层**：CI 脚本通过 AST 扫描检查是否直接使用 `os.getenv`，要求新增环境变量必须先在 `env_schema.py` 中声明。
- **环境变量命名规范**：应用级开关统一以 `VIBE_TRADING_` 前缀（如 `VIBE_TRADING_DATA_CACHE`、`VIBE_TRADING_TOOL_TIMEOUT_SECONDS`），第三方服务密钥使用各自前缀（如 `OPENAI_API_KEY`、`TUSHARE_TOKEN`）。
- **布尔值解析统一**：通过 `_parse_env_bool` 或 `accessor._parse_bool`，不接受大小写敏感的字符串歧义。
- **配置格式限制**：结构化配置文件仅支持 JSON 和 YAML（YAML 需可选依赖 `pyyaml`），不支持其他格式；解析失败会记录警告并回退到空配置。
- **Live broker 白名单强制**：任何指向 `*.robinhood.com` 或 `*.ibkr.com` 的 MCP server 必须显式列出 `enabled_tools`，不允许通配符。
- **OAuth 传输约束**：使用 `auth` 的 HTTP MCP server 必须使用 HTTPS，且不得同时设置静态 `headers`（由 OAuth provider 管理 Authorization 头）。
- **向后兼容别名**：`accessor.get_env_or()` 支持新旧环境变量名回退（如 `VIBE_TRADING_API_KEY` → `API_AUTH_KEY`），`OcrConfig` 中对 `VIBE_TRADING_OCR_QWEN_MODEL` 到 `VIBE_TRADING_OCR_LLM_MODEL` 的迁移带弃用警告。
- **线程安全**：`EnvConfig` 单例通过 `threading.Lock` 保护，支持运行时 `reset_env_config()` 后重新加载。
- **路径安全**：`get_runtime_root()` 拒绝 UNC 路径（`//` 开头），防止跨域路径注入。

## 5. 适用性判断

本仓库存在完整、成熟且被 CI 强制执行的配置系统，涵盖环境变量建模、结构化配置加载、运行时覆盖、安全门控、路径迁移等全部维度，属于 high confidence 的 configuration_system 范畴。