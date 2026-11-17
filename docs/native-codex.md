# 本机 Codex 接入

TabFlow 通过 Chrome Native Messaging 连接官方 Codex CLI 的 `app-server`，读取认证状态和模型目录，并执行标签分类。登录凭据由 Codex 管理，扩展不接收登录令牌或账号邮箱。模型由 CLI 当前配置决定，可能使用云端推理。

普通标签管理和本地规则分类不依赖本机桥接。模型数据去向见 [隐私与数据说明](../PRIVACY.md)，功能验证步骤见 [功能验证指南](testing.md)。

## 平台支持

| 平台 | 当前 TabFlow 配套情况 |
| --- | --- |
| Windows | 提供 PowerShell 在线安装器，安装器预演与桥接协议有自动化测试 |
| macOS | 提供在线安装器，已由开发者实机验证可用 |

两个平台都可以在偏好设置复制命令，下载并直接执行安装脚本，再由脚本安装桥接文件、生成启动器并注册 host。无需手动下载源码或解压安装包。Node.js 和官方 Codex CLI 需提前安装。

## Windows 安装

需要 Node.js 24+ 和官方 Codex CLI。本机 host 不包含在扩展 ZIP 内。

先在当前 Windows 用户下完成 `codex login` 或相应提供商配置。在 TabFlow 偏好设置选择「本机 Codex」，复制安装引导中的命令，在 PowerShell 的任意目录运行。命令会下载并直接执行安装器，并使用当前扩展的实际 ID 注册 host，无需下载完整源码或管理员权限。

安装器将 `native-bridge.mjs`、`codex-app-server.mjs`、启动器和 host 清单保存在 `%LOCALAPPDATA%\TabFlowNativeHost`。所需桥接文件会从安装器同目录复制，缺少时从 GitHub 下载；全部下载成功后才替换本机桥接文件。

### 从源码安装

如果已有完整源码，也可以在包含 `scripts` 的项目根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1
```

省略 `-ExtensionId` 时，从源码安装会根据开发清单的公钥推导扩展 ID；在线执行或独立下载的安装器默认使用商店扩展 ID `pnjgkehmcfheoecnhenfeidkpkdjifkm`。设置页生成的命令始终携带当前扩展的实际 ID。

若提示 `-File` 指定的脚本不存在，当前目录没有 `scripts\install-native-host.ps1`。使用设置页的独立安装命令，或先切换到完整源码的项目根目录；扩展 ZIP 内没有此脚本。

重新加载扩展，在偏好设置中选择「本机 Codex」并刷新状态和模型列表。未安装 host、未完成认证或模型查询失败时，会显示实际错误；基础功能仍可使用。

### 指定目标扩展 ID

不同构建或安装方式的 ID 可能不同。请在 `chrome://extensions/` 开启开发者模式，复制目标 TabFlow 的 ID，先预演，再安装：

```powershell
$extensionId = Read-Host '粘贴目标 TabFlow 的扩展 ID'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1 -ExtensionId $extensionId -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1 -ExtensionId $extensionId
```

`-WhatIf` 需要有效的 Node.js、Codex 及可选 `CodexHome` 路径，但不会写入文件或注册表。安装器每次只注册一个允许的扩展来源，重新绑定会替换旧 ID。检查 host 清单中的 `allowed_origins` 是否与目标扩展一致。

### 安装器参数

| 参数 | 用途 |
| --- | --- |
| `-ExtensionId` | 显式指定允许连接的目标扩展 ID |
| `-NodePath` | 指定 Node.js 可执行文件 |
| `-CodexPath` | 指定官方 Codex 原生可执行文件或 Node CLI 入口，不接受 shell 包装器 |
| `-CodexHome` | 指定 Codex 配置目录，默认继承安装时的 `CODEX_HOME` |
| `-InstallDirectory` | 指定生成启动器和 host 清单的目录 |
| `-WhatIf` | 输出安装计划，核对路径、扩展 ID 和注册内容 |

安装器源码见 [install-native-host.ps1](../scripts/install-native-host.ps1)。安装完成后可以移动或删除下载文件及源码目录，启动器使用用户安装目录内的桥接副本。更新桥接时重新运行安装命令。

## 连接检查

1. 确认官方 Codex CLI 在同一用户下可以正常启动，认证或提供商配置可用。
2. 确认 host 清单的 `allowed_origins` 包含 Chrome 中目标 TabFlow 的实际 ID。
3. 修改 host 配置后，重新加载扩展并重新打开相关界面。
4. 在偏好设置选择「本机 Codex」，刷新认证状态和模型目录。

模型出现在目录中不保证具备调用权限或额度。验证分类时使用公开测试页面，避免发送私人网址、密钥或敏感提示词。


## 通用推理协议

分组、清理及后续结构化 AI 任务统一调用 `GENERATE_JSON`，传入提示词、输入、输出 JSON Schema 和可选模型；桥接返回 `data` 与实际模型。业务含义、候选 ID 校验和浏览器操作由扩展负责。协议契约见 [本机结构化推理协议](native-inference-protocol.md)。

桥接 3.0 提供协议版本 1，`PING` 返回 `protocolVersion` 和 `supportedActions`。旧版扩展使用的 `CLASSIFY_TABS`、`CLEANUP_TABS` 保留为兼容适配器；新功能不增加 action。已有旧桥接迁移一次后，同一协议内的新任务只更新扩展。身份认证、Codex CLI 协议或运行能力本身发生变化时，仍可能需要更新桥接。
