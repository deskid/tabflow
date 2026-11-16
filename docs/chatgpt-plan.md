# ChatGPT 订阅接入原型

此说明适用于 TabFlow 1.2.2 的实验订阅接入。它通过用户自己的 ChatGPT 计划完成标签分类，不要求本机 CLI、Node.js、Native Messaging Host 或注册脚本，也不使用开发者提供的 API Key。

2026-11-16，用户已确认 1.2.1 的真实账号登录、GPT-6.1-Sol 模型目录与订阅分类成功。该路径保留实验标记：浏览器回调尚无 OpenAI 的扩展专用确认，实际权限与用量仍由账号／工作区政策决定。未记录该次请求的原始响应，不能由测试成功推断服务器具体返回了哪一种格式。既有本机 Codex 模式继续兼容已配置用户。

## 使用与验收

1. 构建原型并在 Chrome 扩展管理页加载 `dist`，或解压测试 ZIP 后加载解压目录。这是开发测试，不会修改已提交的原始商店包。
2. 打开偏好设置，将分类引擎选为「ChatGPT 订阅（实验）」。
3. 点击 **Continue with ChatGPT**，授予本次登录需要的网站权限，然后在 OpenAI 页面登录并授权自己的计划。完成后账户行显示已连接，模型目录自动加载。
4. 成功取得计划推理权限后读取当前账户的模型目录；若原模型不在目录，自动选取服务端排序第一项，也可自行选择目录中的模型。
5. 使用几个公开测试页面进行一次智能分组。只有订阅请求确认完整完成、最终分组 JSON 通过校验，且界面显示使用「ChatGPT 订阅」完成分组，才算真实推理路径成功。正常流式响应必须收到 `response.completed`；客户端也可识别标准完整 Responses JSON 的 `status: completed`，这只是返回格式容错，不代表 SIWC 官方承诺会返回非流式 JSON。

账号已登录、计划 scope 已授予或模型目录可读取，都不能单独证明推理权限与额度可用。若结果提示“已改用域名规则”，本次不算订阅推理成功。记录失败时仅提供安全的 HTTP 状态、错误码、请求编号或脱敏描述，不提供授权码、token 或私人网址。

账户与模型采用两行布局：连接后隐藏登录按钮，切换账户、重新授权及退出放入账户菜单。关闭设置、侧栏或独立窗口不会退出，重开界面会恢复同一活动账号；MV3 后台服务休眠／重启也不清除会话。完整结束 Chrome 进程、禁用或重载扩展才会销毁本次运行时会话，之后需重新连接。

## 官方协议与浏览器适配

使用官方 [Sign in with ChatGPT 开源应用流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md)：

- 初次注册使用 `dynamic_agent_client`、稳定的 `urn:uuid:` host ID 与真实应用名 TabFlow。
- 每次授权生成新的 state、OIDC nonce 与 PKCE S256；用回调签发的 client ID 交换授权码，并验证 ID token 的 RS256/JWKS 签名、issuer、audience、nonce、时间及 subject。
- 已注册账户重登复用对应 client ID 与 host ID；不把第一方 Codex 客户端 ID 当作 TabFlow 身份。
- 同时验证 `resource.invoke` 与 `chatgpt.tokens.use.direct` scope，缺少任一项就禁止计划推理。
- 推理只请求官方 `https://api.openai.com/v1/responses`；不调用 ChatGPT backend-api，不读取本机认证文件或浏览器 Cookie。

官方文档描述的是 `http://127.0.0.1:1455/auth/callback` 回调监听器。原型用一条 DNR session rule，把**本次 OAuth 标签页**对该精确地址的主导航转到扩展回调页；不创建本机服务、不全局劫持 loopback 请求。回调页只传递授权码和事务字段，后台会话核心检查真实回调端口的扩展 ID、OAuth tab ID、回调页 URL 与一次性 state。完成、取消、超时或授权标签页关闭时清理规则；关闭设置页不取消后台登录事务。

回调页必须允许由 `https://auth.openai.com` 发起的导航。只允许 127.0.0.1 的 WAR 配置会在真实 Chrome 中被阻止；开发浏览器回归覆盖此 initiator 条件。该技术验证不等于 OpenAI 对扩展适配的批准或真实计划授权成功。

## 凭据与请求边界

Access、refresh 与 ID token 只由独立 DedicatedWorker 的授权核心持有，不写入 local、session、sync、IndexedDB 或文件。该工作器由按需创建的私有 offscreen 文档承载（`WORKERS` 原因），避免把会话绑定在设置页面或会休眠的 MV3 Service Worker 上。前台只通过白名单 RPC 取得账号、模型与分组结果，不提供读取 access token 的 RPC；现有凭据验证、scope、轮换刷新、请求取消与完整分组校验仍在同一核心执行。为避免导航历史保留凭据，当前实现不把 ID token 放入授权 URL，也不记录授权 URL。非令牌的账号标签、返回的邮箱、已验证 subject/client ID 与 host UUID 保存在 `chrome.storage.local`，不参与 Chrome 同步。

续期请求按会话串行，使用最新轮换 refresh token。临时网络或服务错误保留凭据并有界退避，不返回过期 access token；确认失效的授权才结束会话。刷新后缺少计划 scope 时保留有效身份、禁止推理。重新登录与退出不会被旧刷新覆盖；退出会等待已开始的续期，再尝试撤销最新可续期会话。

模型目录按官方 `models / slug / visibility` 格式处理。分类请求设置 `store: false`、`stream: true`，不发送预览流程不支持的 temperature、max_output_tokens 或 previous_response_id；按正文明确的事件流 framing 或完整 Responses JSON 结构识别返回格式，Content-Type 会归一化并保留为诊断。SSE 必须有完成事件；JSON 必须是标准 `object: response / status: completed / output[]` 或明确的 `response.completed` 终事件封装。两条路径共用最终消息校验，非空 error／incomplete_details、未完成状态、拒绝、无效文本均被拒绝；只提取最终 output_text，不从任意文本、裸 groups 或 SDK 便捷字段猜测结果。流中错误、空终帧、EOF 与 `[DONE]` 不能批准此前的增量。

协议失败会附安全的 HTTP 状态、媒体类型、响应形状与已过滤 request ID，不回显响应正文、HTML、detail、提示词或凭据。HTTP 200 中的错误对象依然是失败，不能以状态码 200 代替推理成功。

最终分组验证组名、颜色以及每个输入标签 ID 恰好出现一次；未知、重复或遗漏 ID 都会拒绝。请求失败不会改用 API Key 或其他付费接口。已有的显式域名规则回退仍按真实引擎与错误原因提示，不能标为模型成功。

完整数据流见 [隐私说明](../PRIVACY.md)。API Key 的既有同步方式及完整 URL 发送策略未在此原型中变更。

## 开发验证

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
pnpm test:session
pnpm package:store
```

`pnpm test` 使用模拟 Chrome、OAuth 签名数据与模型响应，不使用真实账号或模型额度。`pnpm test:browser` 要求安装支持扩展调试的现代 Chrome；可用 `TABFLOW_CHROME_BIN` 指定浏览器可执行文件。它在独立临时配置中加载构建副本，授予测试 fixture 的固定主机权限，检查 UI 与模拟授权页面回跳，不操作日常浏览器配置，也不向 OpenAI 提交授权或推理。

`pnpm test:session` 仅在复制的测试构建中注入合成 RSA 密钥与响应，实际运行原授权／模型核心和 Chrome API；无 CORS 响应头的自有随机端口探针同时检查工作器的真实跨域访问权限。它关闭所有 TabFlow 页面、强制停止该隔离 Chrome 的 Service Worker，再重开界面并分类，断言只交换一次授权码、活动账号和 offscreen 文档保持不变、浏览器存储无凭据，以及退出确实调用撤销；不附加凭据工作器调试器延长生命周期，不联系真实 OpenAI 或用户已有的本机服务。

模拟浏览器测试不等于真实端点验收；当前已有用户对 1.2.1 真实登录、模型目录与一次分类成功的确认，1.2.2 的会话迁移采用同一授权／推理核心，长时间运行后的实际续期尚未单独验收。仅更新源码与构建产物，不修改 Google 后台，也不覆盖 1.1.0 原始送审归档。

参考：[官方模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md)、[令牌保存与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md)、[Chrome offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)。
