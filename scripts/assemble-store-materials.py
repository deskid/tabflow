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

2026-11-15（Asia/Shanghai）已提交 Chrome Web Store 审核，当前状态为待审核，通过后自动发布已勾选；尚未审核通过或正式公开。中文（中国），免费、公开分发，所有地区及未列地区均勾选。后台发布者显示名保留原值 deskidzhou@gmail.com，支持邮箱相同。

1. `upload/tabflow-{VERSION}-chrome-web-store.zip` 是已送审的独立上传包，保持原始内容。**不要把本资料包整体当扩展上传。**
2. 中文文案、工具类别、5 项图片素材、9 项权限理由、隐私政策及审核测试说明已保存。实际记录见 `store/submission-record.md`。
3. `store/privacy-disclosures.md` 保留预备解释；本次后台没有独立 Remote Code 或可选主机理由字段，不代表选择或填写了这些字段。
4. 隐私政策 URL：https://deskid.github.io/tabflow/privacy.html 。2026-11-15 已验证匿名 HTTP 200、版本 1.1.0 与联系邮箱，并已保存至后台。
5. 如需可选 Windows Codex，按 `native-host/README.md` 绑定实际商店扩展 ID pnjgkehmcfheoecnhenfeidkpkdjifkm。
6. 用户亲自通过 Google 验证邮件完成联系邮箱验证，后台已读回通过状态；不据此推断身份认证、费用或两步验证的具体完成情况。等待审核结果及公开后的安装验收。

详细入口见 `store/README.md`。验证结果及上传 ZIP 的 SHA-256 见 `验证记录.md`。

图片制作阶段使用真实 React 界面与合成演示数据，未加载个人浏览器资料；此次获授权的真实 Chrome 后台操作另记于提交记录，不与演示数据阶段混同。没有真实模型调用成功承诺。API Key 同步、完整网址发送和云端标签 ID 校验的现有边界保留，见内部提交检查单。

本资料包在本地生成，只收录可公开材料，不收录私人商店后台截图或操作记录。发布准备源码已推送 GitHub，隐私政策已公开并验证；已送审不代表通过审核。
'''
native_readme = '''# 可选 Windows Codex 桥接

此目录是独立本机配套程序，不放进商店扩展上传 ZIP。需要 Node.js 24+、官方 Codex CLI 和有效的 CLI 提供商配置／认证。请先查阅项目说明：https://github.com/deskid/tabflow 。

将本目录完整解压到稳定位置后，在本目录运行。以下已填入本项目商店条目的实际扩展 ID；条目尚未公开：

```powershell
$storeExtensionId = 'pnjgkehmcfheoecnhenfeidkpkdjifkm'
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
