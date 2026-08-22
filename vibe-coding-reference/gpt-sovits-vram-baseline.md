# GPT-SoVITS 显存基线报告

测试时间：2026-08-16 22:50:35 +08:00

## 测试口径

- 直接调用 `api_v2.py`，不经过中间件与播放器。
- API 进程：复用已有进程（PID=7680）
- API 就绪耗时：0.1s；GPU：NVIDIA GeForce RTX 2060, 6144 MB
- 空闲等待：15s；合成后等待：5s；峰值窗口样本数：2
- PYTORCH_CUDA_ALLOC_CONF：未由本脚本注入（继承复用进程）
- 测试文本：你好，欢迎来到直播间，今天天气真不错。
- 合成角色：default（樱羽艾玛）
- 默认角色权重：F:/AiSound/GPT-SoVITS-v2pro-20250604/GPT_weights_v2ProPlus/ema-e15.ckpt / F:/AiSound/GPT-SoVITS-v2pro-20250604/SoVITS_weights_v2ProPlus/ema_e8_s2232.pth
- 合成参数：text_split_method=cut5, streaming_mode=True
- 峰值窗口口径：从 set_gpt_weights 开始，到 /tts 响应读完结束（含权重切换与合成）。
- 注意：`streaming_mode=true` 下载的是「WAV 头 + PCM 分片」流式拼接，不是标准完整 WAV，`audioBytes` 仅作参考。

## 结果

| 指标 | 数值 |
| --- | ---: |
| 启动后空闲显存（tts_infer.yaml custom 模型） | 4369 MB |
| 启动后空闲 GPU 利用率 | 22 % |
| 切换到默认角色后空闲显存 | 4960 MB |
| 切换到默认角色后空闲 GPU 利用率 | 38 % |
| 切换 + 合成窗口显存峰值 | 4960 MB |
| 切换 + 合成窗口 GPU 利用率峰值 | 26 % |
| 合成结束 5s 后显存 | 4801 MB |
| 合成结束 5s 后 GPU 利用率 | 21 % |
| 音频大小 | 368684 bytes |

> 合成后回落到约 4801 MB；应与「切换到默认角色后空闲」4960 MB 对比，两者接近说明 empty_cache 常驻回收有效。