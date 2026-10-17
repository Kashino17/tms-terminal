#!/usr/bin/env python3
"""Prompt rewriter sidecar — long-running process for transforming voice transcripts into polished AI prompts.

Reads JSON Lines from stdin, rewrites with Llama 3.2 3B Instruct (MLX), writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "req-1", "transcript": "user spoken text"}
  Response: {"id": "req-1", "text": "rewritten prompt"}
  Error:    {"id": "req-1", "error": "reason"}
"""

import os
import sys
import json
import re

# Prefer the 30B-A3B MoE coding model already installed on this M4 Max (only 3B
# active params per token -> ~100+ tok/s, 30B quality, 100% local on disk).
LOCAL_CANDIDATES = [
    os.path.expanduser("~/.lmstudio/models/lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-4bit"),
    os.path.expanduser("~/.lmstudio/models/mlx-community/gemma-4-26b-a4b-it-4bit"),
]
FALLBACK_HF_REPO = "mlx-community/Llama-3.2-3B-Instruct-4bit"
MODEL_ID = FALLBACK_HF_REPO
MAX_TOKENS = 512

# Strip <think>...</think> blocks and any "Rewritten prompt:" style preamble.
THINK_RE = re.compile(r"<think>[\s\S]*?</think>\s*", re.IGNORECASE)
PREAMBLE_RE = re.compile(
    r"^\s*(?:(?:here is|here's|hier ist)[^:\n]{0,60}:|rewritten prompt\s*:|umgeschriebener prompt\s*:|prompt\s*:|korrigierter text\s*:)\s*",
    re.IGNORECASE,
)


def resolve_rewriter_model():
    for path in LOCAL_CANDIDATES:
        if os.path.isdir(path) and os.path.exists(os.path.join(path, "config.json")):
            return path
    try:
        from huggingface_hub import snapshot_download
        return snapshot_download(repo_id=FALLBACK_HF_REPO, local_files_only=True)
    except Exception:
        return FALLBACK_HF_REPO


def strip_preamble(text):
    cleaned = THINK_RE.sub("", text or "").strip()
    cleaned = PREAMBLE_RE.sub("", cleaned).strip()
    # Unwrap if the whole output got quoted.
    if len(cleaned) >= 2 and cleaned[0] == '"' and cleaned[-1] == '"':
        cleaned = cleaned[1:-1].strip()
    return cleaned or text


SYSTEM_PROMPT = (
    "Du bist ein präziser Diktat- und Prompt-Optimierer für einen Software-Entwickler (TMS Terminal / Claude Code).\n"
    "Wandle das gesprochene Transkript in einen klaren, sauberen Text um.\n"
    "Regeln:\n"
    "- Behalte die Absicht, Details und die Anredeform (IMMER 'du'/'dir', NIEMALS 'Sie') exakt bei.\n"
    "- Korrigiere Grammatik, Zeichensetzung und entferne Füllwörter (ähm, halt, irgendwie, sozusagen).\n"
    "- Korrigiere typische Hörfehler bei Fachbegriffen automatisch (z. B. 'Cloud Code' → 'Claude Code', "
    "'Web View' → 'WebView', 'Tail Scale' → 'Tailscale', 'T M S' → 'TMS', 'P T Y D' → 'ptyd', "
    "'React Nativ' → 'React Native', 'Work Tree' → 'Worktree').\n"
    "- Nutze kurze Aufzählungspunkte nur bei mehreren getrennten Aufgaben, sonst normalen Fließtext.\n"
    "- Behalte die Originalsprache bei (Deutsch bleibt Deutsch, Englisch bleibt Englisch).\n"
    "- Gib AUSSCHLIESSLICH den bereinigten Text aus. Keine Einleitung, keine Erklärung, keine Anführungszeichen."
)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.write("[rewriter-sidecar] Starting up...\n")
    sys.stderr.flush()

    try:
        from mlx_lm import load, generate
    except ImportError as e:
        sys.stderr.write(f"[rewriter-sidecar] Missing dependency: {e}\n")
        sys.stderr.write("[rewriter-sidecar] Install with: pip install mlx-lm\n")
        sys.stderr.flush()
        sys.exit(1)

    resolved_model = resolve_rewriter_model()
    sys.stderr.write(f"[rewriter-sidecar] Loading model {resolved_model}...\n")
    sys.stderr.flush()
    model, tokenizer = load(resolved_model)
    sys.stderr.write("[rewriter-sidecar] Model loaded.\n")
    sys.stderr.write("[rewriter-sidecar] Ready for requests.\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        req_id = req.get("id", "unknown")
        transcript = (req.get("transcript") or "").strip()

        if not transcript:
            print(json.dumps({"id": req_id, "error": "Empty transcript"}))
            continue

        try:
            messages = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": transcript},
            ]
            prompt = tokenizer.apply_chat_template(
                messages, add_generation_prompt=True, tokenize=False
            )
            output = generate(
                model,
                tokenizer,
                prompt=prompt,
                max_tokens=MAX_TOKENS,
                verbose=False,
            )
            text = strip_preamble((output or "").strip())
            if not text:
                text = transcript
            print(json.dumps({"id": req_id, "text": text}))
        except Exception as e:
            sys.stderr.write(f"[rewriter-sidecar] Error on {req_id}: {e}\n")
            sys.stderr.flush()
            print(json.dumps({"id": req_id, "error": str(e)}))


if __name__ == "__main__":
    main()
