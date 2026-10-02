#!/usr/bin/env python3
"""faster-whisper transcription worker for the Wolffish speech-to-text plugin.

Runs inside the hermetic uv-managed venv provisioned by the `python` capability
(faster-whisper → CTranslate2 + PyAV; no PyTorch, no external ffmpeg). The Node
plugin invokes this per request; it loads the model, transcribes (or just detects
the language), prints JSON to stdout, and exits. Diagnostics go to stderr.

Modes:
  --detect-only   print {detected, confidence, top5} and exit
  (default)       transcribe --audio and print {text, language, segments}

Exit codes: 0 ok, 2 bad args, 3 model/load error, 4 transcription error.
"""
from __future__ import annotations

import argparse
import json
import sys


def log(msg: str) -> None:
    print(f"[stt] {msg}", file=sys.stderr, flush=True)


def load_model(size: str, download_root: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover - provisioning guarantees this
        log(f"faster-whisper import failed: {exc}")
        sys.exit(3)
    try:
        # int8 on CPU: smallest + fastest, ideal for this use case.
        return WhisperModel(
            size,
            device="cpu",
            compute_type="int8",
            download_root=download_root or None,
        )
    except Exception as exc:  # noqa: BLE001
        log(f"failed to load model '{size}': {exc}")
        sys.exit(3)


def detect(model, audio: str) -> None:
    # faster-whisper's model.detect_language() expects decoded audio, not a path.
    # transcribe(language=None) decodes the file (via PyAV) and populates `info`
    # with the language + full probability list BEFORE the segment generator is
    # iterated — so reading it here is cheap (no full transcription).
    try:
        _segments, info = model.transcribe(audio, language=None)
        lang = info.language
        prob = float(info.language_probability or 0.0)
        all_probs = getattr(info, "all_language_probs", None) or [(lang, prob)]
        top5 = sorted(all_probs, key=lambda x: -x[1])[:5]
        json.dump(
            {
                "detected": lang,
                "confidence": round(prob, 4),
                "top5": [{"lang": l, "prob": round(float(p), 4)} for l, p in top5],
            },
            sys.stdout,
        )
        sys.stdout.flush()
    except Exception as exc:  # noqa: BLE001
        log(f"language detection failed: {exc}")
        sys.exit(4)


def transcribe(model, audio: str, language: str) -> None:
    try:
        segments, info = model.transcribe(audio, language=(language or None), vad_filter=False)
        out_segments = []
        parts = []
        for s in segments:  # generator — iterating performs the transcription
            parts.append(s.text)
            out_segments.append(
                {
                    "start": round(float(s.start), 3),
                    "end": round(float(s.end), 3),
                    "text": s.text.strip(),
                }
            )
        json.dump(
            {
                "text": "".join(parts).strip(),
                "language": info.language or "",
                "segments": out_segments,
            },
            sys.stdout,
        )
        sys.stdout.flush()
    except Exception as exc:  # noqa: BLE001
        log(f"transcription failed: {exc}")
        sys.exit(4)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="faster-whisper worker")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model-size", default="base")
    parser.add_argument("--language", default="")
    parser.add_argument("--download-root", default="")
    parser.add_argument("--detect-only", action="store_true")
    args = parser.parse_args(argv)

    model = load_model(args.model_size, args.download_root)
    if args.detect_only:
        detect(model, args.audio)
    else:
        transcribe(model, args.audio, args.language)


if __name__ == "__main__":
    main()
