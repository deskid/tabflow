# TabFlow 中文公开上架材料

目标版本 **1.1.0**，个人开发者，中文（简体），公开发布。支持邮箱 **deskidzhou@gmail.com**；发布者显示名暂用 **deskid**，以开发者后台最终设置为准。

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

## 发布前仍需完成

1. 个人开发者账号注册、费用、邮箱及后台要求的验证。
2. 上传商店 ZIP，取得实际商店扩展 ID，供可选本机桥接安装器绑定。
3. 发布并匿名验证本轮更新的隐私政策 URL；候选 Pages 地址尚未启用或验证，不能直接当作已上线链接。
4. 最后核对数据处理声明、审核所需测试访问与素材，再由开发者本人提交审核并公开发布。

本目录包含草稿和内部检查说明，不代表 Google 已审核通过。本轮准备不自动提交 Git、推送、部署页面或提交商店。
