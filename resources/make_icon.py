"""Rebuild the NordCode app icon set from resources/icon-source.png (the ComfyUI-generated fjord
mark): crop square, round the corners, and export resources/icon.png (512), a multi-size
resources/icon.ico, and the in-app src/renderer/assets/logo.png. Pillow only."""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'icon-source.png')
ICON_PNG = os.path.join(HERE, 'icon.png')
ICON_ICO = os.path.join(HERE, 'icon.ico')
LOGO_PNG = os.path.normpath(os.path.join(HERE, '..', 'src', 'renderer', 'assets', 'logo.png'))

SS = 4
S = 512 * SS
src = Image.open(SRC).convert('RGBA')
# center-crop to square (in case it isn't), then scale to the supersampled canvas
w, h = src.size
m = min(w, h)
src = src.crop(((w - m) // 2, (h - m) // 2, (w - m) // 2 + m, (h - m) // 2 + m)).resize((S, S), Image.LANCZOS)

mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(100 * SS), fill=255)
out = Image.new('RGBA', (S, S), (0, 0, 0, 0))
out.paste(src, (0, 0), mask)
out = out.resize((512, 512), Image.LANCZOS)

out.save(ICON_PNG)
out.save(LOGO_PNG)
out.save(ICON_ICO, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print('wrote icon.png + icon.ico + logo.png from', SRC)
