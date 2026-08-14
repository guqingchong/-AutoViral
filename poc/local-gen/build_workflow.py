"""MiniMax H3 ComfyUI API 工作流构建器

用法: py build_workflow.py <输出json路径> <prompt> <宽> <高> <帧数> <种子> <文件名前缀>
帧数需满足 17k+5 网格（5s@24fps = 124）
"""
import json
import random
import sys

MODELS = {
    "unet": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "clip": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "video_vae": "minimax_h3_video_vae_fp16.safetensors",
    "audio_vae": "minimax_h3_audio_vae_fp32.safetensors",
}


def build(prompt_text, width, height, length, seed, prefix):
    return {"prompt": {
        "6":   {"class_type": "UNETLoader", "inputs": {"unet_name": MODELS["unet"], "weight_dtype": "default"}},
        "13":  {"class_type": "CLIPLoader", "inputs": {"clip_name": MODELS["clip"], "type": "minimax", "device": "default"}},
        "11":  {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["video_vae"]}},
        "24":  {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["audio_vae"]}},
        "104": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["13", 0], "vae": ["11", 0],
            "prompt": prompt_text, "width": width, "height": height, "length": length}},
        "15":  {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "17":  {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "9":   {"class_type": "BasicScheduler", "inputs": {"model": ["6", 0], "scheduler": "simple", "steps": 20, "denoise": 1.0}},
        "16":  {"class_type": "BasicGuider", "inputs": {"model": ["6", 0], "conditioning": ["104", 0]}},
        "14":  {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["15", 0], "guider": ["16", 0], "sampler": ["17", 0],
            "sigmas": ["9", 0], "latent_image": ["104", 1]}},
        "10":  {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0], "vae": ["11", 0]}},
        "23":  {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["14", 0], "vae": ["24", 0]}},
        "91":  {"class_type": "CreateVideo", "inputs": {"images": ["10", 0], "fps": 24.0, "audio": ["23", 0], "bit_depth": 8}},
        "92":  {"class_type": "SaveVideo", "inputs": {"video": ["91", 0], "filename_prefix": prefix, "format": "auto", "codec": "auto"}},
    }}


def frames_for_seconds(sec, fps=24):
    """时长(秒) → 17k+5 网格帧数"""
    raw = max(5, round(sec * fps))
    return raw + (5 - (raw % 17)) % 17


if __name__ == "__main__":
    out, prompt_text, w, h, length, seed, prefix = (
        sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]),
        int(sys.argv[5]), int(sys.argv[6]) if len(sys.argv) > 6 else random.randint(1, 2**63),
        sys.argv[7] if len(sys.argv) > 7 else "poc/output",
    )
    with open(out, "w", encoding="utf-8") as f:
        json.dump(build(prompt_text, w, h, length, seed, prefix), f, ensure_ascii=False)
    print(f"{out} written: {w}x{h} {length}f seed={seed}")
