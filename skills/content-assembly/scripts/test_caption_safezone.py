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

# PlayRes 自适应(2026-09-01 横屏支持)
ass_wide = cg.build_ass([[{"word": "横屏字幕", "start": 0.0, "end": 1.0}]], config, play_res=(1920, 1080))
assert "PlayResX: 1920" in ass_wide and "PlayResY: 1080" in ass_wide, "横屏 PlayRes 未生效"
style_w = next(l for l in ass_wide.splitlines() if l.startswith("Style: Default,"))
fields_w = style_w.split(",")
# v_scale = 1080/1920 = 0.5625: margin_v 430→242, font 52→29
assert fields_w[21] == str(round(430 * 0.5625)), f"横屏 MarginV 应等比缩放为 242,实际 {fields_w[21]}"
assert fields_w[2] == str(round(52 * 0.5625)), f"横屏字号应等比缩放为 29,实际 {fields_w[2]}"
# 竖屏默认不变(回归)
ass_p = cg.build_ass([[{"word": "竖屏字幕", "start": 0.0, "end": 1.0}]], config)
assert "PlayResY: 1920" in ass_p
print("PLAYRES OK")
