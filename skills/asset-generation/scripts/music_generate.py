#!/usr/bin/env python3
"""
MiniMax 音乐生成工具（海螺音乐 music-2.6）
通过 MiniMax API 调用 music-2.6 模型生成背景音乐。

默认生成纯器乐（无人声），适合短视频/播客/Vlog 等场景的 BGM。

用法:
    # 基础生成（纯器乐 BGM）
    python3 music_generate.py --prompt "轻快的电子风格背景音乐" --output bgm.mp3

    # 带人声的音乐（需要提供歌词）
    python3 music_generate.py --prompt "一首温柔的民谣" --lyrics "歌词..." --output song.mp3

    # 生成 60 秒纯器乐
    python3 music_generate.py --prompt "舒缓的钢琴曲" --duration 60 --output long.mp3

环境变量（从 .env 读取）:
    MINIMAX_API_KEY  MiniMax API 密钥
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

# ── 配置 ──────────────────────────────────────────────────────────────

MINIMAX_BASE_URL = "https://api.minimax.chat/v1"
DEFAULT_MODEL = "music-2.6"
POLL_INTERVAL = 5  # seconds
MAX_POLL_TIME = 300  # 5 minutes


# ── .env 读取 ────────────────────────────────────────────────────────


def load_env() -> dict[str, str]:
    """从 .env 文件加载环境变量。"""
    search_roots = []

    if project_dir := os.environ.get("AUTOVIRAL_PROJECT_DIR"):
        search_roots.append(Path(project_dir))

    search_roots.append(Path.home() / ".autoviral")
    search_roots.append(Path(__file__).resolve().parent)
    search_roots.append(Path.cwd())

    for root in search_roots:
        current = root
        for _ in range(10):
            candidate = current / ".env"
            if candidate.exists():
                env_vars = {}
                with open(candidate) as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" in line:
                            key, _, value = line.partition("=")
                            env_vars[key.strip()] = value.strip()
                return env_vars
            current = current.parent
    return {}


def get_api_key() -> str:
    key = os.environ.get("MINIMAX_API_KEY", "")
    if not key:
        env_vars = load_env()
        key = env_vars.get("MINIMAX_API_KEY", "")
    if not key:
        print("[错误] 未配置 MINIMAX_API_KEY", file=sys.stderr)
        sys.exit(1)
    return key


# ── 音乐生成 ─────────────────────────────────────────────────────────


def submit_music_task(
    api_key: str,
    prompt: str,
    lyrics: str = "",
    is_instrumental: bool = True,
    duration: int = 30,
) -> dict:
    """提交音乐生成任务，返回响应数据（可能直接包含 audio URL 或 task_id）"""

    url = f"{MINIMAX_BASE_URL}/music_generation"
    payload: dict = {
        "model": DEFAULT_MODEL,
        "prompt": prompt,
        "is_instrumental": is_instrumental,
        "audio_setting": {
            "sample_rate": 44100,
            "bitrate": 128000,
            "format": "mp3",
        },
        "output_format": "url",
    }

    if lyrics:
        payload["lyrics"] = lyrics

    resp = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=180,
    )

    if not resp.ok:
        raise RuntimeError(f"MiniMax API 错误 {resp.status_code}: {resp.text[:500]}")

    data = resp.json()
    base_resp = data.get("base_resp", {})
    if base_resp.get("status_code") != 0:
        raise RuntimeError(f"MiniMax 错误 {base_resp.get('status_code')}: {base_resp.get('status_msg')}")

    return data


def query_music_task(api_key: str, task_id: str) -> dict:
    """查询音乐生成任务状态"""

    url = f"{MINIMAX_BASE_URL}/query/music_generation"
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {api_key}"},
        params={"task_id": task_id},
        timeout=60,
    )

    if not resp.ok:
        raise RuntimeError(f"查询错误 {resp.status_code}: {resp.text[:500]}")

    return resp.json()


def download_audio(url: str, output_path: str) -> str:
    """下载音频文件到本地"""

    resp = requests.get(url, timeout=180, stream=True)
    if not resp.ok:
        raise RuntimeError(f"下载失败 {resp.status_code}: {url}")

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    with open(out, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)

    return str(out.resolve())


def generate_music(
    api_key: str,
    prompt: str,
    output_path: str,
    vocal: bool = False,
    lyrics: str = "",
    duration: int = 30,
) -> dict:
    """调用 MiniMax 生成音乐

    Args:
        api_key: MiniMax API key
        prompt: 音乐描述/指令
        output_path: 输出文件路径
        vocal: 是否包含人声（默认 False，纯器乐）
        lyrics: 歌词（vocal=True 时建议提供）
        duration: 音频时长（秒，仅作参考，实际由模型决定）
    """
    print(f"[*] 模型: {DEFAULT_MODEL}", file=sys.stderr)
    print(f"[*] 人声: {'是' if vocal else '否（纯器乐）'}", file=sys.stderr)
    print(f"[*] 提交任务...", file=sys.stderr)

    data = submit_music_task(
        api_key,
        prompt,
        lyrics=lyrics if vocal else "",
        is_instrumental=not vocal,
        duration=duration,
    )

    status_data = data.get("data", {})

    # 情况 1：API 直接返回音频 URL（同步完成）
    audio_url = status_data.get("audio")
    if audio_url:
        print(f"[*] 音频已生成，直接下载...", file=sys.stderr)
        saved_path = download_audio(audio_url, output_path)
        size_kb = Path(saved_path).stat().st_size / 1024
        print(f"[*] 已保存音频 ({size_kb:.1f} KB) -> {saved_path}", file=sys.stderr)
        return {
            "success": True,
            "output": saved_path,
            "size_kb": round(size_kb, 1),
            "model": DEFAULT_MODEL,
            "has_vocals": vocal,
            "trace_id": data.get("trace_id", ""),
        }

    # 情况 2：返回 task_id，需要轮询
    task_id = status_data.get("task_id")
    if not task_id:
        raise RuntimeError(f"响应中无 audio URL 或 task_id: {json.dumps(data, ensure_ascii=False)[:500]}")

    print(f"[*] Task ID: {task_id}", file=sys.stderr)

    start_time = time.time()
    audio_url = None
    status = "processing"

    while time.time() - start_time < MAX_POLL_TIME:
        time.sleep(POLL_INTERVAL)
        data = query_music_task(api_key, task_id)
        status_data = data.get("data", {})
        status = status_data.get("status", "unknown")

        print(f"\r[*] 任务状态: {status} ({int(time.time() - start_time)}s)", file=sys.stderr, end="")

        if status == "SUCCESS":
            audio_url = status_data.get("audio_file_url")
            print("", file=sys.stderr)
            break
        elif status in ("FAILED", "ERROR", "FAILURE"):
            print("", file=sys.stderr)
            raise RuntimeError(f"任务失败: {status_data.get('error_message', json.dumps(status_data))}")

    if not audio_url:
        raise RuntimeError(f"轮询超时（{MAX_POLL_TIME}秒），任务未完成，最终状态: {status}")

    print(f"[*] 下载音频...", file=sys.stderr)
    saved_path = download_audio(audio_url, output_path)

    size_kb = Path(saved_path).stat().st_size / 1024
    print(f"[*] 已保存音频 ({size_kb:.1f} KB) -> {saved_path}", file=sys.stderr)

    return {
        "success": True,
        "output": saved_path,
        "size_kb": round(size_kb, 1),
        "model": DEFAULT_MODEL,
        "has_vocals": vocal,
        "task_id": task_id,
    }


# ── 主入口 ──────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="MiniMax 音乐生成工具（海螺音乐 music-2.6）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 基础生成（纯器乐 BGM）
  %(prog)s --prompt "轻快的电子风格背景音乐，适合科技产品展示" --output bgm.mp3

  # 带人声的音乐（需提供歌词）
  %(prog)s --prompt "一首温柔的中文民谣，关于旅行" --lyrics "歌词..." --output song.mp3

  # 纯器乐长 BGM
  %(prog)s --prompt "舒缓的钢琴曲" --output long.mp3

模型:
  music-2.6  MiniMax 海螺音乐（固定使用）

说明:
  默认生成纯器乐（无人声），适合短视频/播客/Vlog 等场景。
  使用 --lyrics 标志并提供歌词可生成带人声的音乐。
""",
    )
    parser.add_argument("--prompt", required=True, help="音乐描述/生成指令")
    parser.add_argument("--output", required=True, help="输出文件路径（如 bgm.mp3）")
    parser.add_argument(
        "--lyrics",
        help="歌词文本（提供歌词则生成带人声的音乐，否则纯器乐）",
    )
    parser.add_argument(
        "--duration", type=int, default=30,
        help="音频参考时长（秒），默认 30（实际时长由模型决定）",
    )

    args = parser.parse_args()
    api_key = get_api_key()

    try:
        result = generate_music(
            api_key,
            prompt=args.prompt,
            output_path=args.output,
            vocal=bool(args.lyrics),
            lyrics=args.lyrics or "",
            duration=args.duration,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:
        error = {"success": False, "error": str(e)}
        print(json.dumps(error, ensure_ascii=False, indent=2))
        sys.exit(1)


if __name__ == "__main__":
    main()
