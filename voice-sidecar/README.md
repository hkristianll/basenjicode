# NordCode voice sidecar

A tiny **local** HTTP service that gives NordCode speech-to-text and text-to-speech —
the "JARVIS" voice loop. Same idea as LM Studio (`:1234`) and ComfyUI (`:8188`):
NordCode talks to it over `127.0.0.1`, nothing leaves the machine.

- **STT** — [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (`small.en` by
  default). Runs on the **GPU** when CUDA 12 cuBLAS/cuDNN are available, otherwise CPU.
- **TTS** — [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) (82M neural voice),
  British male `bm_george` by default. Model files (~336 MB) download on first run.
- **Wake word** — [openWakeWord](https://github.com/dscripka/openWakeWord) (`hey_jarvis`).
  Optional, hands-free: when armed it listens on the **OS default microphone**, and on "Hey Jarvis"
  records the command, transcribes it, and streams events over SSE. ⚠️ It uses the *default* input
  device — if that isn't the mic you speak into, set it as default in Windows sound settings.

## Run

```powershell
pip install -r requirements.txt      # one time
./run.ps1                            # or: python server.py
```

Then in NordCode: **Settings → Voice → Enable voice**. The mic button appears in the
composer; hold it (or press the orb) to talk, and replies are spoken back.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | `{status, stt, tts, wake}` capabilities + per-engine load errors |
| POST | `/stt` | WAV bytes (`audio/wav`) | `{"text": "..."}` |
| POST | `/tts` | `{"text","voice"}` | `audio/wav` bytes |
| POST | `/wake/start` · `/wake/stop` | — | arm / disarm hands-free listening |
| GET | `/events` | — | SSE stream of wake events: `wake`, `listening`, `transcribing`, `command`, `idle`, `error` |

## Config (env vars)

| Var | Default | Notes |
|---|---|---|
| `NORDCODE_VOICE_HOST` | `127.0.0.1` | loopback only |
| `NORDCODE_VOICE_PORT` | `8123` | |
| `NORDCODE_STT_MODEL` | `small.en` | any faster-whisper id (`base.en`, `distil-large-v3`, …) |
| `NORDCODE_STT_DEVICE` | `auto` | `auto` \| `cuda` \| `cpu` |
| `NORDCODE_TTS_VOICE` | `bm_george` | Kokoro voice (`bm_lewis`, `am_michael`, `af_heart`, …) |
| `NORDCODE_TTS_LANG` | `en-gb` | |
| `NORDCODE_WAKE_MODEL` | `hey_jarvis` | openWakeWord model (`alexa`, `hey_mycroft`, …) |
| `NORDCODE_WAKE_THRESHOLD` | `0.5` | detection score 0–1 (raise to reduce false triggers) |

## Notes

- Models warm in the background at startup, sequentially (loading faster-whisper and
  kokoro-onnx in parallel threads trips a Python 3.14 circular-import race).
- GPU STT needs CUDA **12** cuBLAS/cuDNN (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`).
  The server adds their DLL folders to the search path at startup. If they're missing
  or fail to load, it transparently falls back to CPU.
