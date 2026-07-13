#!/usr/bin/env python3
"""
前置环境检测 — 素材生成前全面检查可用能力

在开始生成前运行此脚本，报告：
1. 生成服务提供商状态（API Key、登录态）
2. ffmpeg 能力（字幕滤镜、转场、编码器）
3. Python 依赖（moviepy、Pillow、stable-ts）
4. 字体资源
5. 磁盘和网络

用法:
    python3 check_environment.py                    # JSON 输出（默认）
    python3 check_environment.py --format table     # 人类可读表格
    python3 check_environment.py --format summary   # 一段话摘要

Agent 应在素材生成阶段的第一步运行此脚本，根据结果选择合适的工具和降级策略。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


# ═══════════════════════════════════════════════════════════════════════
# 工具检测
# ═══════════════════════════════════════════════════════════════════════

def check_command(name: str, version_flag: str = "--version") -> dict:
    """检查命令行工具是否可用"""
    exe = shutil.which(name)
    result = {"name": name, "available": exe is not None, "path": exe}
    if exe:
        try:
            proc = subprocess.run([exe, version_flag], capture_output=True, text=True, timeout=5)
            # 取第一行非空输出作为版本
            lines = [l for l in (proc.stdout + proc.stderr).split("\n") if l.strip()]
            result["version"] = lines[0].strip() if lines else "unknown"
        except Exception:
            result["version"] = "error"
    return result


def check_python_module(module_name: str, import_name: str | None = None) -> dict:
    """检查 Python 模块是否可导入"""
    name = import_name or module_name
    try:
        __import__(name)
        return {"name": module_name, "available": True}
    except ImportError:
        return {"name": module_name, "available": False, "install": f"pip install {module_name}"}


# ═══════════════════════════════════════════════════════════════════════
# ffmpeg 能力检测
# ═══════════════════════════════════════════════════════════════════════

def check_ffmpeg_filters() -> dict:
    """检测 ffmpeg 滤镜和编码器能力"""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"available": False, "filters": {}, "encoders": {}, "error": "ffmpeg not found"}

    try:
        proc = subprocess.run([ffmpeg, "-filters"], capture_output=True, text=True, timeout=10)
        filters_output = proc.stdout + proc.stderr
    except Exception:
        return {"available": True, "filters": {}, "encoders": {}, "error": "ffmpeg -filters failed"}

    # 关键滤镜检测
    key_filters = {
        "drawtext": "drawtext",
        "ass": "ass",
        "subtitles": "subtitles",
        "xfade": "xfade",
        "overlay": "overlay",
        "scale": "scale",
        "concat": "concat",
        "format": "format",
        "fade": "fade",
        "setpts": "setpts",
    }

    filters_status = {}
    for name, pattern in key_filters.items():
        # 搜索 " T" (timeline supported) 或 " V" (video filter) 或 " A" (audio) 前缀
        found = pattern in filters_output
        filters_status[name] = found

    # 编码器检测
    try:
        proc = subprocess.run([ffmpeg, "-encoders"], capture_output=True, text=True, timeout=10)
        encoders_output = proc.stdout + proc.stderr
    except Exception:
        encoders_output = ""

    key_encoders = {"libx264": "libx264", "libx265": "libx265", "aac": "aac", "libmp3lame": "libmp3lame"}
    encoders_status = {}
    for name, pattern in key_encoders.items():
        encoders_status[name] = pattern in encoders_output

    # libass / libfreetype 编译检测
    libass = "libass" in filters_output or "enable-libass" in filters_output
    libfreetype = "libfreetype" in filters_output or "enable-libfreetype" in filters_output or "freetype" in filters_output

    return {
        "available": True,
        "filters": filters_status,
        "encoders": encoders_status,
        "libass": libass,
        "libfreetype": libfreetype,
        "subtitle_capable": filters_status.get("drawtext", False) or filters_status.get("ass", False) or filters_status.get("subtitles", False),
    }


# ═══════════════════════════════════════════════════════════════════════
# 字体检测
# ═══════════════════════════════════════════════════════════════════════

def check_fonts() -> dict:
    """检测项目字体可用性"""
    fonts_dir = Path.home() / ".autoviral" / "fonts"
    if not fonts_dir.exists():
        return {"available": False, "fonts_dir": str(fonts_dir), "fonts": [], "error": "fonts dir not found"}

    fonts = []
    for ext in ["*.otf", "*.ttf", "*.ttc"]:
        for f in fonts_dir.glob(ext):
            fonts.append(f.name)

    # 优先字体
    preferred = ["NotoSansCJKsc-Bold.otf", "NotoSansCJKsc-Regular.otf", "NotoSerifCJKsc-Bold.otf"]

    return {
        "available": len(fonts) > 0,
        "fonts_dir": str(fonts_dir),
        "fonts": sorted(fonts),
        "preferred_available": [f for f in preferred if f in fonts],
    }


# ═══════════════════════════════════════════════════════════════════════
# 综合检测
# ═══════════════════════════════════════════════════════════════════════

def check_environment() -> dict:
    """综合环境检测"""

    # 1. 命令行工具
    ffmpeg_info = check_command("ffmpeg", "-version")
    python_info = {"name": "python3", "available": True, "version": sys.version.split()[0]}

    # 2. ffmpeg 能力
    ffmpeg_caps = check_ffmpeg_filters()

    # 3. Python 依赖
    py_modules = [
        check_python_module("moviepy", "moviepy"),
        check_python_module("Pillow", "PIL"),
        check_python_module("stable-ts", "stable_whisper"),
        check_python_module("requests"),
        check_python_module("numpy"),
    ]

    # 4. 字体
    fonts = check_fonts()

    # 5. 生成服务提供商（复用 check_providers.py 的逻辑）
    providers = _check_providers_minimal()

    # 6. 汇总能力矩阵
    capabilities = {
        "image_generation": providers.get("capabilities", {}).get("image_generation", False),
        "video_generation": providers.get("capabilities", {}).get("video_generation", False),
        "music_generation": providers.get("capabilities", {}).get("music_generation", False),
        "professional_subtitles": (
            fonts["available"]
            and all(m["available"] for m in py_modules if m["name"] in ["Pillow", "moviepy"])
        ),
        "auto_captions": any(m["name"] == "stable-ts" and m["available"] for m in py_modules),
        "ffmpeg_subtitles": ffmpeg_caps.get("subtitle_capable", False),
        "hardware_encoder": ffmpeg_caps.get("encoders", {}).get("libx264", False),
    }

    # 7. 推荐
    recommended = _build_recommendations(capabilities, providers, ffmpeg_caps)

    return {
        "timestamp": __import__("datetime").datetime.now().isoformat(),
        "platform": sys.platform,
        "tools": {"ffmpeg": ffmpeg_info, "python": python_info},
        "ffmpeg": ffmpeg_caps,
        "python_modules": py_modules,
        "fonts": fonts,
        "providers": providers.get("providers", []),
        "capabilities": capabilities,
        "recommended": recommended,
    }


def _check_providers_minimal() -> dict:
    """最小化 provider 检测（复用 check_providers 的逻辑但避免循环导入）"""
    providers = []

    # 读取 .env
    env_vars = {}
    env_paths = [
        Path.home() / ".autoviral" / ".env",
        Path.cwd() / ".env",
    ]
    for p in env_paths:
        if p.exists():
            with open(p) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, _, v = line.partition("=")
                        env_vars[k.strip()] = v.strip()

    # Dreamina CLI
    dreamina_installed = shutil.which("dreamina") is not None
    dreamina_logged_in = False
    dreamina_credit = "?"
    if dreamina_installed:
        try:
            proc = subprocess.run(["dreamina", "user_credit"], capture_output=True, text=True, timeout=10)
            if proc.returncode == 0:
                try:
                    credit_data = json.loads(proc.stdout)
                    dreamina_logged_in = True
                    dreamina_credit = str(credit_data.get("credit", credit_data.get("remaining", "?")))
                except Exception:
                    dreamina_logged_in = True
        except Exception:
            pass

    providers.append({
        "name": "dreamina",
        "available": dreamina_installed and dreamina_logged_in,
        "installed": dreamina_installed,
        "logged_in": dreamina_logged_in,
        "credit": dreamina_credit,
        "supports_image": True,
        "supports_video": True,
        "note": "视频生成首选，Seedance 2.0/3.0 模型" if dreamina_logged_in else "未登录或未安装",
    })

    # OpenRouter
    or_key = env_vars.get("OPENROUTER_API_KEY", "")
    providers.append({
        "name": "openrouter",
        "available": bool(or_key),
        "supports_image": True,
        "supports_video": False,
        "note": "主力图片生成，Gemini 模型",
    })

    # Jimeng
    jm_ak = env_vars.get("JIMENG_ACCESS_KEY", "")
    jm_sk = env_vars.get("JIMENG_SECRET_KEY", "")
    providers.append({
        "name": "jimeng",
        "available": bool(jm_ak and jm_sk),
        "supports_image": True,
        "supports_video": True,
        "note": "视频/图片备用",
    })

    caps = {
        "image_generation": any(p["available"] and p.get("supports_image") for p in providers),
        "video_generation": any(p["available"] and p.get("supports_video") for p in providers),
        "music_generation": bool(or_key),
    }

    return {"providers": providers, "capabilities": caps}


def _build_recommendations(caps: dict, providers: dict, ffmpeg: dict) -> dict:
    """构建推荐方案"""
    rec = {}

    # 字幕推荐
    if caps["professional_subtitles"]:
        rec["subtitles"] = "subtitle_burn.py (Pillow + moviepy) — 零外部依赖，跨平台"
        if caps["auto_captions"]:
            rec["captions"] = "caption_generate.py --input (auto 语音识别模式)"
        else:
            rec["captions"] = "caption_generate.py --timestamps (手动时间戳模式)"
    elif caps["ffmpeg_subtitles"]:
        rec["subtitles"] = "ffmpeg drawtext — 环境支持但推荐安装 Pillow 获得更好的效果"
        rec["captions"] = "手动编写 ASS/SRT"
    else:
        rec["subtitles"] = "不可用 — 请安装 Pillow: pip install Pillow moviepy"
        rec["captions"] = "不可用"

    # 视频生成推荐
    dreamina = next((p for p in providers.get("providers", []) if p["name"] == "dreamina"), {})
    jimeng = next((p for p in providers.get("providers", []) if p["name"] == "jimeng"), {})
    if dreamina.get("available"):
        rec["video"] = "dreamina image2video (首帧驱动，最佳质量)"
    elif jimeng.get("available"):
        rec["video"] = "jimeng_generate.py (备用)"
    else:
        rec["video"] = "不可用 — 请配置 Dreamina CLI 或 JIMENG_ACCESS_KEY/JIMENG_SECRET_KEY"

    # 图片生成推荐
    openrouter = next((p for p in providers.get("providers", []) if p["name"] == "openrouter"), {})
    if openrouter.get("available"):
        rec["image"] = "openrouter_generate.py (Gemini/Flux)"
    else:
        rec["image"] = "不可用 — 请配置 OPENROUTER_API_KEY"

    # 合成推荐
    if caps["hardware_encoder"]:
        rec["assembly"] = "ffmpeg libx264 + subtitle_burn.py — 完整管线可用"
    else:
        rec["assembly"] = "ffmpeg (基础，无硬件编码器) + subtitle_burn.py"

    return rec


# ═══════════════════════════════════════════════════════════════════════
# 输出格式化
# ═══════════════════════════════════════════════════════════════════════

def format_table(result: dict):
    """表格输出"""
    print(f"\n{'='*70}")
    print("  AutoViral 环境检测报告")
    print(f"  时间: {result['timestamp']}  平台: {result['platform']}")
    print(f"{'='*70}")

    # 工具
    print(f"\n─── 命令行工具 ───")
    for tool in [result["tools"]["ffmpeg"], result["tools"]["python"]]:
        status = "✓" if tool["available"] else "✗"
        ver = tool.get("version", "N/A")
        print(f"  [{status}] {tool['name']}: {ver}")

    # ffmpeg 滤镜
    print(f"\n─── ffmpeg 滤镜能力 ───")
    ff = result["ffmpeg"]
    if ff.get("available"):
        for name, ok in ff.get("filters", {}).items():
            print(f"  [{'✓' if ok else '✗'}] {name}")
        print(f"  libass 编译: {'✓' if ff.get('libass') else '✗'}")
        print(f"  libfreetype 编译: {'✓' if ff.get('libfreetype') else '✗'}")
    else:
        print(f"  ✗ ffmpeg 不可用")

    # Python 模块
    print(f"\n─── Python 依赖 ───")
    for m in result["python_modules"]:
        status = "✓" if m["available"] else "✗"
        install = f" → {m['install']}" if not m["available"] and "install" in m else ""
        print(f"  [{status}] {m['name']}{install}")

    # 字体
    print(f"\n─── 字体 ───")
    fonts = result["fonts"]
    print(f"  字体目录: {fonts['fonts_dir']}")
    print(f"  可用字体数: {len(fonts.get('fonts', []))}")
    if fonts.get("preferred_available"):
        print(f"  优先字体: {', '.join(fonts['preferred_available'])} ✓")
    elif fonts.get("available"):
        print(f"  优先字体: 未找到 (NotoSansCJK 未安装)")

    # 生成服务
    print(f"\n─── 生成服务提供商 ───")
    for p in result["providers"]:
        status = "✓ 可用" if p["available"] else "✗ 不可用"
        credit = f" (积分: {p.get('credit', '?')})" if p.get("credit") else ""
        print(f"  [{status}] {p['name']}: {p.get('note', '')}{credit}")

    # 能力汇总
    print(f"\n─── 能力汇总 ───")
    caps = result["capabilities"]
    labels = {
        "image_generation": "图片生成",
        "video_generation": "视频生成",
        "music_generation": "音乐生成",
        "professional_subtitles": "专业字幕渲染 (Pillow+moviepy)",
        "auto_captions": "自动语音识别字幕 (stable-ts)",
        "ffmpeg_subtitles": "ffmpeg 字幕滤镜",
        "hardware_encoder": "硬件视频编码 (libx264)",
    }
    for key, label in labels.items():
        ok = caps.get(key, False)
        print(f"  [{'✓' if ok else '✗'}] {label}")

    # 推荐
    print(f"\n─── 推荐方案 ───")
    rec = result["recommended"]
    for key, label in [("image", "图片生成"), ("video", "视频生成"), ("captions", "字幕生成"), ("subtitles", "字幕烧录"), ("assembly", "视频合成")]:
        val = rec.get(key, "N/A")
        print(f"  {label}: {val}")

    print(f"{'='*70}\n")


def format_summary(result: dict):
    """一段话摘要输出"""
    caps = result["capabilities"]
    rec = result["recommended"]
    parts = []

    if caps.get("image_generation"):
        parts.append(f"图片生成可用")
    else:
        parts.append("⚠️ 图片生成不可用")

    if caps.get("video_generation"):
        parts.append(f"视频生成可用")
    else:
        parts.append("⚠️ 视频生成不可用")

    if caps.get("professional_subtitles"):
        parts.append("字幕渲染可用 (Pillow)")
    elif caps.get("ffmpeg_subtitles"):
        parts.append("字幕渲染可用 (ffmpeg)")
    else:
        parts.append("⚠️ 字幕渲染不可用")

    if caps.get("auto_captions"):
        parts.append("语音识别可用 (stable-ts)")

    missing_deps = [m["name"] for m in result["python_modules"] if not m["available"]]
    if missing_deps:
        parts.append(f"⚠️ 缺失依赖: {', '.join(missing_deps)}")

    print(f"[环境检测] {' | '.join(parts)}")
    if missing_deps:
        install_cmds = " && ".join(
            m["install"] for m in result["python_modules"]
            if not m["available"] and "install" in m
        )
        print(f"[环境检测] 修复: {install_cmds}")


def main():
    parser = argparse.ArgumentParser(description="AutoViral 前置环境检测")
    parser.add_argument("--format", choices=["json", "table", "summary"], default="json")
    args = parser.parse_args()

    result = check_environment()

    if args.format == "table":
        format_table(result)
    elif args.format == "summary":
        format_summary(result)
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
