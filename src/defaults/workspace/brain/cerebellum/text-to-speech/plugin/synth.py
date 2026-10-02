#!/usr/bin/env python3
"""Kokoro text-to-speech synthesis worker for the Wolffish text-to-speech plugin.

Runs inside the hermetic uv-managed venv provisioned by the `python` capability
(kokoro-onnx + soundfile). The Node plugin downloads the model files and invokes
this script per request; the script loads Kokoro, synthesizes one WAV, and exits.
All diagnostics go to stderr so stdout stays clean for structured output.

Modes:
  --list-voices                 print the model's voice ids as JSON to stdout
  (default)                     synthesize --text-file -> --out (WAV)

Exit codes: 0 ok, 2 bad args, 3 model/load error, 4 synthesis error.
"""
from __future__ import annotations

import argparse
import json
import sys

SAMPLE_RATE_FALLBACK = 24000

# Kokoro voice-name prefix -> language code, so a voice is spoken in its own
# language without the caller having to know the mapping. English is the focus;
# the rest are best-effort and fall back to en-us on any phonemizer error.
LANG_BY_PREFIX = {
    "a": "en-us",  # American English
    "b": "en-gb",  # British English
    "e": "es",
    "f": "fr-fr",
    "h": "hi",
    "i": "it",
    "j": "ja",
    "p": "pt-br",
    "z": "cmn",
}


def lang_for_voice(voice: str, default: str = "en-us") -> str:
    return LANG_BY_PREFIX.get(voice[:1], default) if voice else default


def log(msg: str) -> None:
    print(f"[synth] {msg}", file=sys.stderr, flush=True)


def load_kokoro(model_path: str, voices_path: str):
    try:
        from kokoro_onnx import Kokoro
    except ImportError as exc:  # pragma: no cover - provisioning guarantees this
        log(f"kokoro-onnx import failed: {exc}")
        sys.exit(3)
    try:
        return Kokoro(model_path, voices_path)
    except Exception as exc:  # noqa: BLE001
        log(f"failed to load Kokoro model: {exc}")
        sys.exit(3)


def list_voices(model_path: str, voices_path: str) -> None:
    kokoro = load_kokoro(model_path, voices_path)
    if hasattr(kokoro, "get_voices"):
        voices = sorted(kokoro.get_voices())
    else:
        voices = sorted(getattr(kokoro, "voices", {}).keys())
    json.dump({"voices": voices}, sys.stdout)
    sys.stdout.flush()


def synthesize(args: argparse.Namespace) -> None:
    import numpy as np
    import soundfile as sf

    try:
        with open(args.text_file, "r", encoding="utf-8") as fh:
            text = fh.read().strip()
    except OSError as exc:
        log(f"could not read text file: {exc}")
        sys.exit(2)
    if not text:
        log("no text to synthesize")
        sys.exit(2)

    kokoro = load_kokoro(args.model, args.voices)
    voice = args.voice
    speed = float(args.speed)
    lang = args.lang or lang_for_voice(voice)

    try:
        samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
    except Exception as exc:  # noqa: BLE001
        # A non-English phonemizer may be unavailable; retry in English rather
        # than fail outright. Re-raise if we were already English.
        if lang == "en-us":
            log(f"synthesis failed: {exc}")
            sys.exit(4)
        log(f"synthesis failed for lang={lang} ({exc}); retrying in en-us")
        try:
            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
        except Exception as exc2:  # noqa: BLE001
            log(f"synthesis failed: {exc2}")
            sys.exit(4)

    samples = np.asarray(samples, dtype=np.float32)
    sample_rate = int(sample_rate or SAMPLE_RATE_FALLBACK)
    try:
        sf.write(args.out, samples, sample_rate, subtype="PCM_16")
    except Exception as exc:  # noqa: BLE001
        log(f"failed to write WAV: {exc}")
        sys.exit(4)

    duration = len(samples) / sample_rate if sample_rate else 0.0
    json.dump(
        {"out": args.out, "sampleRate": sample_rate, "durationSec": round(duration, 3)},
        sys.stdout,
    )
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Kokoro TTS worker")
    parser.add_argument("--model", required=True, help="path to kokoro onnx model")
    parser.add_argument("--voices", required=True, help="path to voices bin")
    parser.add_argument("--list-voices", action="store_true", help="print voice ids and exit")
    parser.add_argument("--text-file", help="UTF-8 file containing the text to speak")
    parser.add_argument("--out", help="output WAV path")
    parser.add_argument("--voice", default="af_bella")
    parser.add_argument("--speed", default="1.0")
    parser.add_argument("--lang", default="")
    args = parser.parse_args(argv)

    if args.list_voices:
        list_voices(args.model, args.voices)
        return
    if not args.text_file or not args.out:
        log("--text-file and --out are required for synthesis")
        sys.exit(2)
    synthesize(args)


if __name__ == "__main__":
    main()
