"""Create store graphics from the real UI rendered with synthetic data.
Requires Pillow. Run --icons-only before building; then capture preview PNGs.
"""
from pathlib import Path
import argparse
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'store' / 'assets'
ASSETS.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument('--icons-only', action='store_true')
args = parser.parse_args()

icon_path = ROOT / 'public' / 'icons' / 'icon128.png'
with Image.open(icon_path) as source:
    artwork = source.convert('RGBA')
    artwork = artwork.crop(artwork.getchannel('A').getbbox() or (0, 0, 128, 128))
artwork.thumbnail((96, 96), Image.Resampling.LANCZOS)
store_icon = Image.new('RGBA', (128, 128))
store_icon.alpha_composite(artwork, ((128 - artwork.width) // 2, (128 - artwork.height) // 2))
store_icon.save(icon_path, format='PNG', optimize=True)
store_icon.save(ASSETS / 'icon128.png', format='PNG', optimize=True)
for size in (16, 48):
    image_path = ROOT / 'public' / 'icons' / f'icon{size}.png'
    with Image.open(image_path) as source:
        source.convert('RGBA').save(image_path, format='PNG', optimize=True)
if args.icons_only:
    print('Created actual PNG icons; 128px artwork uses a 96px safe area.')
    raise SystemExit(0)


def font(size, bold=False):
    windows = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
    candidates = [windows / ('msyhbd.ttc' if bold else 'msyh.ttc'),
                  Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'),
                  Path('/System/Library/Fonts/PingFang.ttc')]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    raise RuntimeError('A Chinese font (Microsoft YaHei, Noto Sans CJK or PingFang) is required.')


def background(width, height):
    image = Image.new('RGB', (width, height))
    draw = ImageDraw.Draw(image)
    top, bottom = (246, 250, 255), (230, 239, 254)
    for y in range(height):
        ratio = y / max(1, height - 1)
        color = tuple(round(a * (1 - ratio) + b * ratio) for a, b in zip(top, bottom))
        draw.line((0, y, width, y), fill=color)
    return image.convert('RGBA')


scenes = [
    ('tabs', ['标签很多，', '也能清晰有序'], ['把散开的页面收进主题组，', '在侧边栏快速切换与查找。'],
     ['垂直标签与原生分组', '搜索、固定、静音与休眠', '独立窗口绑定浏览会话']),
    ('settings', ['换一种方式，', '整理同一批标签'], ['主题、项目、用途、资料类型，', '六套预设，也能继续自由编辑。'],
     ['选择预设，直接调整偏好', '本地规则开箱即用', 'AI 分类按需配置']),
    ('reading', ['书签与稍后读，', '放在同一处'], ['从临时浏览到长期收藏，', '让有价值的内容更容易回到视线。'],
     ['保存当前页面到稍后读', '区分未读与已读内容', '在来源窗口打开链接']),
]
for index, (scene, headline, subtitle, bullets) in enumerate(scenes, 1):
    raw_path = ROOT / 'artifacts' / 'store-previews' / f'{scene}.png'
    with Image.open(raw_path) as screenshot:
        panel = screenshot.convert('RGBA').resize((520, 700), Image.Resampling.LANCZOS)
    image = background(1280, 800)
    draw = ImageDraw.Draw(image)
    image.alpha_composite(store_icon.resize((64, 64), Image.Resampling.LANCZOS), (68, 48))
    draw.text((144, 57), 'TabFlow', font=font(35, True), fill='#193661')
    draw.text((76, 130), '垂直标签与智能分组', font=font(21), fill='#42698d')
    for row, line in enumerate(headline):
        draw.text((76, 202 + row * 76), line, font=font(57, True), fill='#142d50')
    for row, line in enumerate(subtitle):
        draw.text((80, 385 + row * 38), line, font=font(24), fill='#526983')
    for row, line in enumerate(bullets):
        y = 520 + row * 55
        draw.rounded_rectangle((80, y + 10, 91, y + 21), radius=3, fill='#3c79e5')
        draw.text((108, y), line, font=font(23), fill='#28486c')
    draw.text((80, 754), '界面使用演示数据，不含个人浏览记录', font=font(16), fill='#637d99')
    shadow = Image.new('RGBA', image.size)
    ImageDraw.Draw(shadow).rounded_rectangle((684, 54, 1204, 754), radius=22, fill=(37, 72, 128, 45))
    image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(16)))
    mask = Image.new('L', panel.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 519, 699), radius=18, fill=255)
    image.paste(panel, (684, 50), mask)
    ImageDraw.Draw(image).rounded_rectangle((684, 50, 1203, 749), radius=18, outline='#d5dfed', width=2)
    output = ASSETS / f'screenshot-{index:02d}-{scene}-1280x800.png'
    image.convert('RGB').save(output, format='PNG', optimize=True)
    print(output.relative_to(ROOT))

promo = background(440, 280)
draw = ImageDraw.Draw(promo)
promo.alpha_composite(store_icon.resize((88, 88), Image.Resampling.LANCZOS), (24, 24))
draw.text((120, 43), 'TabFlow', font=font(37, True), fill='#17375e')
draw.text((33, 139), '垂直标签，清晰有序', font=font(28, True), fill='#153456')
draw.text((35, 195), '标签分组   书签   稍后读', font=font(19), fill='#45698e')
draw.text((35, 237), '本地规则开箱即用，可选 AI 分类', font=font(15), fill='#5e7c9c')
promo.convert('RGB').save(ASSETS / 'promo-small-440x280.png', format='PNG', optimize=True)
print('store/assets/promo-small-440x280.png')
