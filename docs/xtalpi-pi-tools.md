# xtalpi-pi-tools 本地工具协议

`xtalpi-pi-tools` 是 pi-67 针对晶泰 OpenAI-compatible 代理的主线 provider。

核心原则：**晶泰只负责普通 chat 文本生成，Pi 本地负责工具协议、解析、校验、重试和执行。**

## 为什么替代 xtalpi-tools

旧的 `xtalpi-tools` 依赖 OpenAI 原生工具字段：

- request 里发送 `tools` / `tool_choice` / `parallel_tool_calls`
- assistant 返回 `tool_calls`
- 下一轮发送 `role=tool`
- streaming 中等待 tool delta / finish_reason

晶泰代理在这些边界上容易出现空 assistant、stream 无 finish_reason、tool result continuation 丢失等问题。

`xtalpi-pi-tools` 不再向晶泰发送原生 tools 字段，而是用普通文本协议：

```text
<pi_tool_call>
{"name":"read","arguments":{"path":"package.json"}}
</pi_tool_call>
```

Pi 本地解析该文本，转换成 Pi 原生 `toolCall` block，然后执行工具。工具结果下一轮作为普通 user 文本发给模型：

```text
<pi_tool_result>
tool_call_id: ...
tool_name: read
is_error: false
content:
...
</pi_tool_result>
```

这样晶泰侧不需要稳定支持 OpenAI tool calling，只需要稳定支持普通 chat completion。

## 默认配置

`settings.json` 默认：

```json
{
  "defaultProvider": "xtalpi-pi-tools",
  "defaultModel": "deepseek-v4-pro",
  "defaultThinkingLevel": "off"
}
```

`models.example.json` 只保留一个晶泰 provider：

```json
{
  "providers": {
    "xtalpi-pi-tools": {
      "baseUrl": "https://sciencetoken-api.xtalpi.xyz/proxy/openai/v1",
      "api": "xtalpi-pi-tools",
      "apiKey": "YOUR_XTALPI_API_KEY"
    }
  }
}
```

> URL 不是秘密，可以写进文档；API key 不要写进仓库、聊天记录或飞书文档。

## 启动方式

普通启动：

```bash
pi
```

显式稳定启动：

```bash
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools.sh
```

等价于：

```bash
pi --provider xtalpi-pi-tools --model deepseek-v4-pro --thinking off
```

## 本地配置 key

推荐通过 configure 写入本机 ignored 的 `~/.pi/agent/models.json`：

```bash
cd ~/.pi/agent
bash scripts/pi67-configure.sh --provider xtalpi-pi-tools --model deepseek-v4-pro --prompt-secrets
```

也可以用环境变量：

```bash
export PI67_XTALPI_API_KEY="你的 key"
bash ~/.pi/agent/scripts/pi67-configure.sh --provider xtalpi-pi-tools --model deepseek-v4-pro --no-prompt
```

兼容旧环境变量：

```bash
PI67_XTALPI_TOOLS_API_KEY=...
```

会被迁移到 `xtalpi-pi-tools`。

升级已有安装时，普通 update 会自动做一次无提示迁移，不会覆盖已有 key：

```bash
bash ~/.pi/agent/scripts/pi67-update.sh
```

如果只想手动迁移配置：

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --provider xtalpi-pi-tools --model deepseek-v4-pro --no-prompt
```

## 运行时可调参数

```bash
# 每轮最多给模型展示多少个工具说明，默认 24
export XTALPI_PI_TOOLS_MAX_TOOLS=24

# 单个工具结果作为普通文本回传时最多保留多少字符，默认 20000
export XTALPI_PI_TOOLS_MAX_TOOL_RESULT_CHARS=20000

# 单次模型输出上限，默认 8192
export XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS=8192

# HTTP 超时，默认 180000ms
export XTALPI_PI_TOOLS_TIMEOUT_MS=180000

# 空响应最多修复 2 次
export XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES=2

# 非法工具 JSON / 未知工具 / 重复工具最多修复 2 次
export XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES=2

# 单轮总恢复次数上限，默认 4，避免无限循环
export XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES=4

# 输出脱敏 debug 摘要
export XTALPI_PI_TOOLS_DEBUG=1
```

debug 文件默认写入：

```text
$HOME/tmp/xtalpi-pi-tools-debug.jsonl
```

不会记录 Authorization、API key 或完整敏感工具结果。

## 静态测试

```bash
bash ~/.pi/agent/scripts/pi67-test-xtalpi-pi-tools.sh
```

覆盖：

- `<pi_tool_call>` 解析
- fenced JSON 容错
- 多工具调用拒绝
- unknown top-level field 拒绝
- tool result 作为普通 user 文本序列化
- payload 不包含 `tools`、`tool_choice`、`parallel_tool_calls`、`thinking`、`reasoning_effort`
- payload 不包含 `role=tool`

## 真实冒烟测试

```bash
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools-smoke.sh
```

覆盖：

1. 无工具普通回答
2. `bash pwd`
3. `read package.json`
4. web/read 混合任务

输出 JSONL artifact 默认在：

```text
$HOME/tmp/xtalpi-pi-tools-smoke
```

## 旧 provider 清理

从 `0.10.0` 开始，pi-67 模板不再提供：

- `xtalpi`
- `xtalpi-tools`
- `extensions/xtalpi-compat`
- `pi67-xtalpi-safe.sh`
- `xtalpi-tool-smoke.sh`

`pi67-configure.sh` 会把旧 `xtalpi` / `xtalpi-tools` 的 key 和 baseUrl 迁移到 `xtalpi-pi-tools`，并默认移除旧 provider。

如果你确实要临时保留旧 provider，可以设置：

```bash
export PI67_KEEP_LEGACY_XTALPI_PROVIDERS=1
```

然后再运行 configure。但 pi-67 主线只维护 `xtalpi-pi-tools`。
