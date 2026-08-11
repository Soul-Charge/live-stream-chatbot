"""
Genie-TTS 迁移阶段 1：角色模型 ONNX 转换脚本。

对每个角色执行：
1. genie_tts.convert_to_onnx 将 .ckpt + .pth 转换为 ONNX 模型目录
   （保存到 F:/AiSound/Genie-TTS-onnx/CharacterModels/<角色>/tts_models）。
2. 校验转换产物（ModelManager 所需的 9 个文件）。
3. 将参考音频复制/转换到 <角色>/prompt_wav/（mp3 会转成 wav），
   并生成 prompt_wav.json（与 Genie-TTS GUI 的角色目录结构一致）。

用法：
    # 全部角色
    .\.venv-genie\Scripts\python.exe scripts\convert_to_onnx.py
    # 只转换某个角色
    .\.venv-genie\Scripts\python.exe scripts\convert_to_onnx.py --only hiro
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

import genie_tts as genie

OUTPUT_ROOT = r"F:\AiSound\Genie-TTS-onnx\CharacterModels"
GPT_WEIGHTS_DIR = r"F:\AiSound\GPT-SoVITS-v2pro-20250604\GPT_weights_v2ProPlus"
SOVITS_WEIGHTS_DIR = r"F:\AiSound\GPT-SoVITS-v2pro-20250604\SoVITS_weights_v2ProPlus"
REF_AUDIO_ROOT = r"F:\AiSound\训练文件\自整理用音频"

# 转换器最终应产出的文件（与 ModelManager / GUI tts_models 一致）
EXPECTED_MODEL_FILES = [
    "t2s_encoder_fp32.bin",
    "t2s_encoder_fp32.onnx",
    "t2s_shared_fp16.bin",
    "t2s_first_stage_decoder_fp32.onnx",
    "t2s_stage_decoder_fp32.onnx",
    "vits_fp16.bin",
    "vits_fp32.onnx",
    "prompt_encoder_fp16.bin",
    "prompt_encoder_fp32.onnx",
]

CHARACTERS = [
    {
        "characterName": "ema",
        "comment": "樱羽艾玛",
        "language": "jp",
        "ckpt": os.path.join(GPT_WEIGHTS_DIR, "ema-e15.ckpt"),
        "pth": os.path.join(SOVITS_WEIGHTS_DIR, "ema_e8_s2232.pth"),
        "refAudio": os.path.join(REF_AUDIO_ROOT, "ema", "0101Adv08_Ema007.ogg"),
        "refText": "あの、その看守のことなんだけど……ボク、さっきアリサちゃんが捕まっちゃってるの見ちゃって……。",
    },
    {
        "characterName": "hiro",
        "comment": "二阶堂希罗",
        "language": "jp",
        "ckpt": os.path.join(GPT_WEIGHTS_DIR, "hiro-e15.ckpt"),
        "pth": os.path.join(SOVITS_WEIGHTS_DIR, "hiro_e8_s2184.pth"),
        "refAudio": os.path.join(REF_AUDIO_ROOT, "hiro", "0101Adv02_Hiro003.ogg"),
        "refText": "正しい説明がなされるのかな。それなら早く向かわないと……。",
    },
    {
        "characterName": "MyGO",
        "comment": "高松灯",
        "language": "jp",
        "ckpt": os.path.join(GPT_WEIGHTS_DIR, "MyGO_高松灯_v2pp.ckpt"),
        "pth": os.path.join(SOVITS_WEIGHTS_DIR, "MyGO_高松灯_v2pp.pth"),
        "refAudio": os.path.join(
            REF_AUDIO_ROOT, "tomori", "新しい模様の見つけたから。買ったのを、整理しようと思って…….mp3"
        ),
        "refText": "新しい模様の見つけたから。買ったのを、整理しようと思って……",
    },
    {
        "characterName": "诗歌剧",
        "comment": "诗歌剧",
        "language": "jp",
        "ckpt": os.path.join(GPT_WEIGHTS_DIR, "诗歌剧.ckpt"),
        "pth": os.path.join(SOVITS_WEIGHTS_DIR, "诗歌剧.pth"),
        "refAudio": os.path.join(
            REF_AUDIO_ROOT, "曼波诗歌剧", "マチカネタンホイザです！よろよろです～♪.mp3"
        ),
        "refText": "マチカネタンホイザです！よろよろです～♪",
    },
    {
        "characterName": "sherry",
        "comment": "橘雪莉",
        "language": "jp",
        "ckpt": os.path.join(GPT_WEIGHTS_DIR, "sherry-e15.ckpt"),
        "pth": os.path.join(SOVITS_WEIGHTS_DIR, "sherry_e8_s808.pth"),
        "refAudio": os.path.join(REF_AUDIO_ROOT, "sherry", "0101Adv08_Sherry008.ogg"),
        "refText": "私もエマさんと同じですよ。魔法なんて初めて知りましたし、使えません。",
    },
]


def verify_model_files(model_dir: str) -> list:
    missing = []
    for name in EXPECTED_MODEL_FILES:
        if not os.path.isfile(os.path.join(model_dir, name)):
            missing.append(name)
    return missing


def prepare_reference_audio(char_dir: str, src_audio: str, ref_text: str) -> str:
    """把参考音频放入 <char>/prompt_wav/，mp3 用 ffmpeg 转成 wav；返回 prompt_wav.json 的 wav 字段值。"""
    prompt_dir = os.path.join(char_dir, "prompt_wav")
    os.makedirs(prompt_dir, exist_ok=True)

    ext = os.path.splitext(src_audio)[1].lower()
    if ext == ".mp3":
        dst_name = os.path.splitext(os.path.basename(src_audio))[0] + ".wav"
        dst_path = os.path.join(prompt_dir, dst_name)
        if not os.path.isfile(dst_path):
            cmd = ["ffmpeg", "-y", "-v", "error", "-i", src_audio, dst_path]
            subprocess.run(cmd, check=True)
            print(f"  [ref] mp3 -> wav: {dst_path}")
        wav_name = dst_name
    else:
        wav_name = os.path.basename(src_audio)
        dst_path = os.path.join(prompt_dir, wav_name)
        if not os.path.isfile(dst_path):
            shutil.copy2(src_audio, dst_path)
            print(f"  [ref] copied: {dst_path}")

    prompt_json = {
        "Normal": {
            "wav": wav_name,
            "text": ref_text,
        }
    }
    with open(os.path.join(char_dir, "prompt_wav.json"), "w", encoding="utf-8") as f:
        json.dump(prompt_json, f, ensure_ascii=False, indent=2)
    return dst_path


def convert_character(chara: dict) -> bool:
    name = chara["characterName"]
    char_dir = os.path.join(OUTPUT_ROOT, name)
    model_dir = os.path.join(char_dir, "tts_models")
    os.makedirs(model_dir, exist_ok=True)

    print(f"\n===== 转换 {name}（{chara['comment']}）=====")
    for key in ("ckpt", "pth"):
        path = chara[key]
        if not os.path.isfile(path):
            print(f"  ❌ 输入文件不存在: {path}")
            return False
        print(f"  [in] {os.path.basename(path)} ({os.path.getsize(path) / 1024 / 1024:.1f} MB)")

    t0 = time.time()
    try:
        genie.convert_to_onnx(
            torch_ckpt_path=chara["ckpt"],
            torch_pth_path=chara["pth"],
            output_dir=model_dir,
        )
    except Exception as exc:
        print(f"  ❌ 转换异常: {exc}")
        return False

    missing = verify_model_files(model_dir)
    if missing:
        print(f"  ❌ 产出缺失: {missing}")
        return False

    total_mb = sum(
        os.path.getsize(os.path.join(model_dir, f)) / 1024 / 1024 for f in os.listdir(model_dir)
        if os.path.isfile(os.path.join(model_dir, f))
    )
    print(f"  ✅ 转换完成，耗时 {time.time() - t0:.0f}s，tts_models 共 {total_mb:.1f} MB")
    print(f"  [out] {model_dir}")

    ref_audio = prepare_reference_audio(char_dir, chara["refAudio"], chara["refText"])
    print(f"  [ref] {ref_audio}")
    print(f"  [ref] prompt_wav.json 已生成")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="只转换指定 characterName")
    args = parser.parse_args()

    targets = [c for c in CHARACTERS if c["characterName"] == args.only] if args.only else CHARACTERS
    if not targets:
        print(f"未找到角色: {args.only}")
        sys.exit(2)

    results = []
    for chara in targets:
        ok = convert_character(chara)
        results.append((chara["characterName"], ok))

    print("\n===== 汇总 =====")
    for name, ok in results:
        print(f"  {'✅' if ok else '❌'} {name}")
    if not all(ok for _, ok in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
