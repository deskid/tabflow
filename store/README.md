# TabFlow 中文公开上架材料

提交版本 **1.1.0**，中文（中国），免费、公开分发。2026-11-15（Asia/Shanghai）已提交 Chrome Web Store 审核，当前为**待审核**，已选择审核通过后自动发布，尚未审核通过或正式公开。支持邮箱及后台原有发布者显示名均为 **deskidzhou@gmail.com**；本次未更改发布者显示名或交易者身份设置。

## 材料入口

| 材料 | 使用位置 |
| --- | --- |
| [中文商店文案](listing-zh-CN.md) | 商店名称、简短描述、详细介绍、主页与支持链接 |
| [隐私与权限申报](privacy-disclosures.md) | 单一用途、9 项权限、可选主机、数据类型和 Remote Code 草稿 |
| [审核测试说明](reviewer-guide.md) | 后台审核说明，基础无凭据测试与可选模型集成 |
| [提交检查单](submission-checklist.md) | 开发者账号、公开政策 URL、商店 ID 与最终人工确认 |
| [素材说明](assets/README.md) | 图标、3 张截图和小推广图，含尺寸及演示数据说明 |
| [隐私政策](../PRIVACY.md)／[静态网页](../docs/privacy.html) | 政策公开托管源码，公开邮箱已填入 |

## 生成上传 ZIP

在项目根目录执行：

```sh
pnpm check
pnpm package:store
```

命令输出最终 ZIP 路径。上传 ZIP 来自生产构建，根目录直接包含清单，仅删除上传副本中的开发公钥；本地开发清单和现有解压版身份保持独立。不要上传整个源码目录或整套材料压缩包。

新安装默认使用本地规则；已有模型配置保留。商店包的基本功能需要 Chrome 120 或更新版本，端侧模型另受 Chrome、设备和语言支持条件限制。API Key 同步、完整 URL 传输和云端 ID 校验的现有边界没有因本轮材料准备而变更。

## 图片复现

素材由真实生产 React 界面和合成演示数据生成，再与中文介绍排版。不加载个人浏览器资料，不执行真实模型调用；界面图不是来自用户真实浏览会话，图片中已标出演示数据。

先准备真实 PNG 图标并构建，然后运行本地演示服务；第二个终端完成截图与排版：

```sh
python scripts/create-store-assets.py --icons-only
pnpm build
node scripts/store-preview.mjs
```

```sh
node scripts/capture-store-previews.mjs
python scripts/create-store-assets.py
```

图片脚本需要 Pillow 和可用中文字体；截图脚本需要 Chrome，可通过 CHROME_PATH 指定路径。演示服务仅绑定 127.0.0.1，使用独立浏览器资料目录，接口模拟代码不进入商店上传包。完成后停止演示服务。

## 发布进度与后续步骤

1. 2026-11-15（Asia/Shanghai）已最终提交审核；Google 显示「已将您的扩展程序提交送审」及「待审核」，通过后自动发布已勾选。详见 [公开提交记录](submission-record.md)。
2. 实际扩展 ID 为 `pnjgkehmcfheoecnhenfeidkpkdjifkm`。文案、工具类别、中文（中国）、5 项图片素材、隐私申报及审核测试说明均已保存；分发免费、公开，所有地区及未列地区均勾选。
3. [公开源码](https://github.com/deskid/tabflow) 已包含发布准备提交；[公开隐私政策](https://deskid.github.io/tabflow/privacy.html) 已从 main 的 `/docs` 发布，2026-11-15 已匿名验证 HTTP 200，包含 1.1.0 和联系邮箱，并已保存至后台。
4. 联系邮箱经用户亲自点击 Google 邮件链接验证，后台显示已通过验证；本次未读取邮箱。不据此推断费用、身份认证或两步验证的具体完成情况。
5. 等待审核结果；如要求补充测试访问，按真实要求处理。审核通过自动发布后，再验证公开商店页和最终安装行为。

本目录仍保留可复用字段和预备解释；其中 Remote Code、可选主机理由没有对应的独立后台字段，不能理解为已填入这些字段。已送审不代表 Google 已审核通过。
