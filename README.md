# TabFlow - AI 垂直标签与工作空间

全新原创设计的现代化 Chrome 垂直标签页与工作空间扩展，基于 **Manifest V3 + React 19 + TypeScript + Radix UI Colors + Chrome Native Messaging** 构建。

---

## 🎨 视觉品牌与全新图标 (TabFlow Identity)

- **全新命名**：**TabFlow**（寓意「垂直瀑布流」与「敏捷心流体验」）。
- **全新视觉设计**：
  - 图标采用深邃暗夜黑底色与 0.5px 精细描边微光质感。
  - 核心图形为垂直流式脊柱（Spine Rail），搭配天蓝至电紫的高亮流线卡片（Cyan to Electric Indigo Glow）与层级嵌套子标签。
  - 高对比度矢量几何排布，在 16x16 浏览器顶栏、48x48 扩展管理页与 128x128 视网膜高清屏下均保持清晰辨识度。

---

## 🌟 核心特性全览

### 1. 本机 Codex 免授权原生桥接 (Native Messaging)
- **免手动填 Key**：自动读取本机 `~/.codex/auth.json` 登录凭据，直接复用当前账号的会话额度与模型。
- **模型灵活切换**：支持从本机已授权的 60+ 款模型中任意选择（如 Gemini 3.8 Flash、DeepSeek V4.1 Flash、GPT-6 Astra 等）。
- **自定义提示词**：支持自由输入分类意向（按项目、按业务线、定制组名风格），提供一键恢复默认。

### 2. 打开新标签页自动归类 (Auto-Group on New Tab)
- 监听新页面加载完成事件，自动匹配当前窗口已有标签组的域名或关键词。
- 相同网站的标签页自动入组，达到 2 个以上未成组标签自动新建主题组。
- 设置中提供独立开关随时启闭。

### 3. 垂直标签管理与原生协同 (Vertical Tabs & Groups)
- 零延迟双向同步 Chrome 原生标签与标签组。
- 状态感知：声音波形（点击静音）、内存休眠感知（一键唤醒）、固定标签专区、中键关闭、右键上下文操作。
- 标签组折叠/展开、调色盘切换、解散分组与一键转存为书签。

### 4. 极简设计系统 (Radix UI Colors + 0.5px Hairline)
- 基于 `@radix-ui/colors` 12 阶语义阶梯，所有边框统一采用 0.5px 极细边框（Retina 高清锐利质感）。
- 严格控制文字层级（仅 3 级：14px / 13px / 12px，杜绝任何低于 12px 的字体）。
- 全局禁用中点「·」字符，采用语义间距呈现状态数据。

---

## 🚀 安装与加载指南

1. 构建已就绪（位于 `/Users/deskid/git/sidetab-pro/dist`）：
   ```bash
   cd /Users/deskid/git/sidetab-pro
   pnpm build
   ```
2. 打开 Chrome，访问 `chrome://extensions/` 并开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择 `/Users/deskid/git/sidetab-pro/dist`。
4. 快捷键 `Command+Shift+P` (Mac) 或 `Ctrl+Shift+P` (Win) 即可呼出 TabFlow 侧边栏。
