# xtalpi 公司 API 工具调用配置

本机对公司 OpenAI-compatible API 做了两层适配：

1. `xtalpi` provider：保留 reasoning，适合少工具或无工具的深度思考任务。
2. `xtalpi-tools` provider：关闭 reasoning 参数，默认用于 Pi agent 工具调用任务。

推荐工具任务使用：

```bash
pi --provider xtalpi-tools --model deepseek-v4-pro
```

本机默认模型已设为：

```json
{
  "defaultProvider": "xtalpi-tools",
  "defaultModel": "deepseek-v4-pro",
  "defaultThinkingLevel": "off"
}
```

所以直接运行 `pi` 会优先进入工具稳定模式；需要无工具深度推理时再手动切到 `xtalpi/deepseek-v4-pro` 并开启 thinking。

快速验证：

```bash
$HOME/.pi/agent/scripts/xtalpi-tool-smoke.sh
```

如果你的任务经常在工具调用后卡在“连续返回空 assistant 内容”，优先用保守启动脚本：

```bash
bash ~/.pi/agent/scripts/pi67-xtalpi-safe.sh
```

这个脚本不修改你的 key 或晶泰服务端，只是在本机启动 Pi 时设置更保守的 xtalpi 参数：

- 最多发送 8 个相关工具定义，降低 90+ tools 场景下的代理压力。
- tool result 仍镜像成普通文本，但单条最多 8000 字符。
- 连续空 assistant 后进入 `rescue_no_tools`：下一轮强制不带 tools、不带 reasoning，并尽量用非流式请求让模型直接基于已有工具结果输出最终文本。

兼容层文件：

```text
$HOME/.pi/agent/extensions/xtalpi-compat/index.ts
```

当前本机侧兼容策略：

- tool result 保留标准 `role: tool`，同时镜像成普通 `user` 文本，避免公司代理丢失工具结果。
- 给 tool result 补 `name`，兼容要求 `role: tool` 带 `name` 的 OpenAI proxy。
- 工具链路关闭 `stream_options.include_usage`，规避 usage 全 0 和空 stream/无 finish_reason 问题。
- 工具链路删除 `thinking` / `reasoning_effort`，规避 reasoning + tools continuation 空回复。
- 设置 `parallel_tool_calls=false`，并在 assistant 消息层面把同一轮多个 sibling tool calls 串行化。
- 处理 `litellm_unnamed_tool_0`，按请求参数、已发送工具集或单工具上下文改回真实工具名。
- 自动隐藏重试空 assistant / 空 stream；连续最多 2 次、单轮最多 4 次，防止 UI 卡在无回复或进入无限循环。
- 默认按当前 prompt 从大量工具中保留最相关的一组，减少公司代理在 90+ tools 下的空回复概率。
- 默认空 assistant 策略是 `rescue_no_tools`：第一次空回后隐藏续问，恢复请求强制无工具、无 reasoning、非流式，优先让任务产出可见文本。

可调环境变量：

```bash
# always: 总是镜像工具结果；off: 关闭；auto: 目前等同有工具历史时镜像
export XTALPI_TOOL_RESULT_MIRROR=always

# 单个 tool result 镜像最大字符数，默认 12000；safe 脚本默认 8000
export XTALPI_MAX_MIRRORED_TOOL_RESULT_CHARS=12000

# auto: 大量工具时按 prompt 过滤；off: 不过滤
export XTALPI_TOOL_FILTER=auto

# 大量工具时最多发送多少个工具定义，默认 12；safe 脚本默认 8
export XTALPI_MAX_TOOLS=12

# rescue_no_tools: 默认，空回后下一轮强制无工具恢复；
# hidden_recovery: 只做旧版隐藏续问；
# fail_fast: 不隐藏续问，直接给出失败提示。
export XTALPI_EMPTY_ASSISTANT_STRATEGY=rescue_no_tools

# 默认不把工具结果摘录显示在最终兜底消息里，避免误露敏感内容。
# 如明确需要“哪怕模型不答也展示工具结果”，可临时开启。
export XTALPI_FALLBACK_INCLUDE_TOOL_EXCERPT=0

# 写脱敏 debug 摘要到 $HOME/tmp/xtalpi-compat-debug.jsonl
export XTALPI_COMPAT_DEBUG=1
```

如果公司服务端未来修复了 OpenAI tool-call 协议，可以逐步关闭：

```bash
export XTALPI_TOOL_RESULT_MIRROR=off
export XTALPI_TOOL_FILTER=off
```
