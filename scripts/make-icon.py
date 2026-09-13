"""Render the app's four-pane vector mark into platform icon formats."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

root = Path(__file__).resolve().parents[1] / "assets"
root.mkdir(exist_ok=True)
scale = 2
canvas = Image.new("RGBA", (1024 * scale, 1024 * scale))
draw = ImageDraw.Draw(canvas)
def rect(box, radius, color):
    draw.rounded_rectangle(tuple(int(n * scale) for n in box), radius=int(radius * scale), fill=color)
rect((66, 74, 958, 966), 198, (22, 56, 103, 35))
canvas = canvas.filter(ImageFilter.GaussianBlur(10 * scale))
draw = ImageDraw.Draw(canvas)
rect((66, 56, 958, 948), 198, "#f4f7fc")
rect((70, 60, 954, 944), 194, "#edf2f9")
rect((225, 215, 491, 481), 47, "#3778da")
rect((533, 215, 799, 481), 47, "#79acef")
rect((225, 523, 491, 789), 47, "#79acef")
rect((533, 523, 799, 789), 47, "#3778da")
canvas = canvas.resize((1024, 1024), Image.Resampling.LANCZOS)
canvas.save(root / "icon.png")
canvas.save(root / "icon.icns", format="ICNS")
canvas.save(root / "icon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (128, 128), (256, 256)])
