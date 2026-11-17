# 本机结构化推理协议

桥接负责认证复用、模型目录、Codex 进程通信和 JSON 推理。业务提示词、输出结构与结果校验属于扩展；新增摘要、推荐、清理等结构化任务不增加桥接 action。

## 请求与响应

```json
{
  "action": "GENERATE_JSON",
  "protocolVersion": 1,
  "model": "可选模型 ID",
  "instructions": "请根据给定文本生成简短摘要。",
  "input": "{\"text\":\"需要摘要的内容\"}",
  "outputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["summary"],
    "properties": { "summary": { "type": "string" } }
  }
}
```

```json
{
  "success": true,
  "type": "INFERENCE",
  "source": "codex-app-server",
  "protocolVersion": 1,
  "data": { "summary": "生成的摘要" },
  "modelUsed": "实际模型 ID"
}
```

`instructions` 作为开发者指令传入；`input` 独立作为任务数据传入；`outputSchema` 原样交给 Codex。模型的 Schema 支持范围仍由 Codex 决定。桥接检查请求边界、解析 JSON，不解释分组或清理含义，也不代替扩展校验业务约束。

请求限制：提示词不超过 16000 字符，输入不超过 100000 字符，Schema 为不超过 64000 字节的 JSON 对象，模型 ID 不超过 200 字符。原生消息总帧仍限制在 1 MiB 以内。

## 扩展调用

```ts
const value = await requestNativeJSON({ instructions, input, outputSchema, model });
// 在业务服务中校验 value，再产生可执行的浏览器操作。
```

分组服务检查组名、颜色、全部输入标签恰好出现一次；清理服务检查候选 ID、动作与原因，后台在关闭前重新检查保护和快照。桥接不会根据推理结果直接操作浏览器。

## 协议与能力

`PING` 不启动 Codex，返回桥接版本、`protocolVersion: 1` 及 `supportedActions`。同一协议下增加新的提示词与输出 Schema 不修改桥接。未知协议返回 `UNSUPPORTED_PROTOCOL`，未知操作返回 `UNKNOWN_ACTION`；请求错误在启动 Codex 前拒绝。

旧接口 `CLASSIFY_TABS`、`CLEANUP_TABS` 仅用于兼容已发布的扩展，内部转换到同一推理流程，保留原响应形状和错误码。新增功能只使用 `GENERATE_JSON`。协议破坏性变更才调整协议版本；底层 CLI 适配及运行能力变更仍可能需要升级桥接。

## 固定运行约束

调用方不能通过请求更改只读沙箱、禁止网络、临时会话、无需审批和禁用工具等运行约束。MCP、Shell、Hooks 及其他本地集成继续关闭；模型请求工具或交互操作会中止推理。请求失败不切换提供商，也不降级成浏览器清理操作。
