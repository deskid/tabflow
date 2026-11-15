"""Assemble the reviewed local delivery bundle; never submits or publishes it."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
OUT = ROOT / 'artifacts' / 'chrome-web-store'
UPLOAD = OUT / f'tabflow-{VERSION}-chrome-web-store.zip'
assert UPLOAD.is_file(), 'Run the release checks and package-store command first.'
with ZipFile(UPLOAD) as archive:
    assert archive.testzip() is None
    names = archive.namelist()
    assert 'manifest.json' in names and not any(name.startswith('dist/') for name in names)
    manifest = json.loads(archive.read('manifest.json'))
    assert manifest['version'] == VERSION and 'key' not in manifest
    assert len(manifest['permissions']) == 9
    assert manifest['minimum_chrome_version'] == '120'
    for name in names:
        assert not any(part in {'node_modules', '.pnpm-store', 'tests', 'scripts', '.git'} for part in name.split('/'))
        assert not name.endswith(('.key', '.pem', '.map', '.log')) and '/.env' not in '/' + name
    for size, name in manifest['icons'].items():
        import io
        with Image.open(io.BytesIO(archive.read(name))) as image:
            assert image.format == 'PNG' and image.size == (int(size), int(size))
            image.verify()

expected = {'icon128.png': (128, 128), 'promo-small-440x280.png': (440, 280),
            'screenshot-01-tabs-1280x800.png': (1280, 800),
            'screenshot-02-settings-1280x800.png': (1280, 800),
            'screenshot-03-reading-1280x800.png': (1280, 800)}
for filename, dimensions in expected.items():
    with Image.open(ROOT / 'store' / 'assets' / filename) as image:
        assert image.format == 'PNG' and image.size == dimensions
        image.verify()

intro = f'''# TabFlow {VERSION} 中文公开上架资料

个人开发者；中文（简体）；公开发布。发布者显示名暂用 deskid，支持邮箱 deskidzhou@gmail.com。

1. 上传 `upload/tabflow-{VERSION}-chrome-web-store.zip` 到 Chrome Web Store 后台。**不要把本资料包整体当扩展上传。**
2. 按 `store/listing-zh-CN.md` 填写中文文案，按 `store/assets/README.md` 上传图片。
3. 核对 `store/privacy-disclosures.md` 与 `store/reviewer-guide.md`，再按后台实际问题确认数据及权限声明。
4. 将 `PRIVACY.md` 或 `docs/privacy.html` 发布到公开可访问地址并匿名验证，再填写政策 URL。候选 Pages 地址尚未部署验证。
5. 如需可选 Windows Codex，取得商店实际扩展 ID 后按 `native-host/README.md` 绑定安装。
6. 账号注册、费用、身份／邮箱验证、政策认证和最终提交由开发者本人完成。

详细入口见 `store/README.md`。验证结果及上传 ZIP 的 SHA-256 见 `验证记录.md`。

图片使用真实 React 界面与演示数据，未读取私人浏览记录；没有真实模型调用成功承诺。API Key 同步、完整网址发送和云端标签 ID 校验的现有边界保留，见内部提交检查单。

本资料包仅本地生成，不代表已推送 GitHub、上线隐私网站或通过商店审核。
'''
native_readme = '''# 可选 Windows Codex 桥接

此目录是独立本机配套程序，不放进商店扩展上传 ZIP。需要 Node.js 24+、官方 Codex CLI 和有效的 CLI 提供商配置／认证。请先查阅项目说明：https://github.com/deskid/tabflow 。

将本目录完整解压到稳定位置后，在本目录运行（将示例变量替换为商店条目实际的 32 位 a-p 小写扩展 ID）：

```powershell
$storeExtensionId = '替换为实际商店扩展ID'
powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\install-native-host.ps1 -ExtensionId $storeExtensionId -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\install-native-host.ps1 -ExtensionId $storeExtensionId
```

预演仍需有效 Node/Codex 路径，但不创建目录、写文件或改注册表。自动发现失败时可显式提供 -NodePath、-CodexPath（官方 .exe 或 .js/.mjs 入口）及可选 -CodexHome。

真实安装为当前用户写 Native Messaging 启动器、清单和两个 HKCU 注册视图，无需管理员权限；桥接从当前解压位置加载，请不要在安装后移动／删除源目录。商店 ID 不应使用本地解压版 ID 代替。省略参数仅按配套开发公钥推导 ID。重新安装会替换该主机的单个允许来源。

本机桥接可调用云端模型，不代表离线。浏览器扩展不接收 CLI 登录令牌；不要向审核员提供个人账号、验证码或长期密钥。当前仅提供 Windows 安装器。
'''
report = OUT / 'verification.md'
assert report.is_file(), 'Write the evidence-based verification report before assembling.'
bundle = OUT / f'tabflow-{VERSION}-store-materials.zip'
with ZipFile(bundle, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
    archive.writestr('开始上架.md', intro)
    archive.writestr('native-host/README.md', native_readme)
    archive.write(UPLOAD, 'upload/' + UPLOAD.name)
    archive.write(report, '验证记录.md')
    for file in sorted((ROOT / 'store').rglob('*')):
        if file.is_file(): archive.write(file, file.relative_to(ROOT).as_posix())
    for relative in ['LICENSE', 'PRIVACY.md', 'docs/privacy.html']:
        archive.write(ROOT / relative, relative)
    for relative in ['scripts/install-native-host.ps1', 'scripts/native-bridge.mjs', 'scripts/codex-app-server.mjs', 'public/manifest.json']:
        archive.write(ROOT / relative, 'native-host/' + relative)
with ZipFile(bundle) as archive:
    assert archive.testzip() is None
print(json.dumps({'upload': UPLOAD.name, 'uploadSha256': hashlib.sha256(UPLOAD.read_bytes()).hexdigest(),
                  'materials': bundle.name, 'materialsBytes': bundle.stat().st_size,
                  'materialsSha256': hashlib.sha256(bundle.read_bytes()).hexdigest()}, ensure_ascii=False, indent=2))
