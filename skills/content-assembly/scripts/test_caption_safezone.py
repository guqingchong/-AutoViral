# skills/content-assembly/scripts/test_caption_safezone.py
# 运行: py -3 skills/content-assembly/scripts/test_caption_safezone.py
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import caption_generate as cg

config = cg.build_style_config("douyin-highlight", {})
lines = [[{"word": "测试字幕", "start": 0.0, "end": 1.0}]]
ass = cg.build_ass(lines, config)
style = next(l for l in ass.splitlines() if l.startswith("Style: Default,"))
fields = style.split(",")
# Format 序: Name(0) Fontname(1) Fontsize(2) Primary(3) Secondary(4) Outline(5)
#   Back(6) Bold(7) Italic(8) Underline(9) StrikeOut(10) ScaleX(11) ScaleY(12)
#   Spacing(13) Angle(14) BorderStyle(15) Outline(16) Shadow(17) Alignment(18)
#   MarginL(19) MarginR(20) MarginV(21) Encoding(22)
assert fields[15] == "3", f"BorderStyle 应为 3(胶囊底盒),实际 {fields[15]}"
assert "&H471E100A" in fields[6].upper(), f"BackColour 应为 &H471E100A,实际 {fields[6]}"
assert int(fields[16]) >= 12, f"胶囊 padding(Outline)应 ≥12,实际 {fields[16]}"
assert fields[21] == "430", f"MarginV 须保持 430(抖音 UI 遮挡区上沿),实际 {fields[21]}"
print("CAPTION SAFEZONE OK")
