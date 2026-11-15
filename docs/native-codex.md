# 本机 Codex 接入

TabFlow 通过 Chrome Native Messaging 连接官方 Codex CLI 的 `app-server`，读取认证状态和模型目录，并执行标签分类。登录凭据由 Codex 管理，扩展不接收登录令牌或账号邮箱。模型由 CLI 当前配置决定，可能使用云端推理。

普通标签管理和本地规则分类不依赖本机桥接。模型数据去向见 [隐私与数据说明](../PRIVACY.md)，功能验证步骤见 [功能验证指南](testing.md)。

## 平台支持

| 平台 | 当前 TabFlow 配套情况 |
| --- | --- |
| Windows | 提供自动安装器，安装器预演与桥接协议有自动化测试 |
| macOS | 尚未提供配套安装器，未完成 macOS 实机验证 |

官方 Codex CLI 支持 macOS，不代表 TabFlow 的安装配置已经覆盖该平台。仓库中的 [Unix 启动脚本](../scripts/native-bridge.sh) 只负责启动 Node 桥接，不会注册 Chrome Native Messaging Host；当前默认 Codex 路径查找也以 Windows 安装布局为主。因此，不能仅凭存在 shell 脚本就将 macOS 标为已完整支持。

## Windows 安装

需要 Node.js 24+、官方 Codex CLI 和完整的 TabFlow 源码目录。本机 host 不包含在扩展 ZIP 内，安装后仍需保留源码目录中的桥接脚本。

先在当前 Windows 用户下完成 `codex login` 或相应提供商配置，再在项目根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1
```

安装器为当前用户生成启动器和 host 清单，并注册 Chrome Native Messaging Host，无需管理员权限。默认根据开发清单中的公钥推导扩展 ID。

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

安装器源码见 [install-native-host.ps1](../scripts/install-native-host.ps1)。安装后若移动或删除桥接源码目录，需要重新安装以更新启动器路径。

## 连接检查

1. 确认官方 Codex CLI 在同一用户下可以正常启动，认证或提供商配置可用。
2. 确认 host 清单的 `allowed_origins` 包含 Chrome 中目标 TabFlow 的实际 ID。
3. 修改 host 配置后，重新加载扩展并重新打开相关界面。
4. 在偏好设置选择「本机 Codex」，刷新认证状态和模型目录。

模型出现在目录中不保证具备调用权限或额度。验证分类时使用公开测试页面，避免发送私人网址、密钥或敏感提示词。
