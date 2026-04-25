#!/usr/bin/env python3
"""Prompt rewriter sidecar — long-running process for transforming voice transcripts into polished AI prompts.

Reads JSON Lines from stdin, rewrites with Llama 3.2 3B Instruct (MLX), writes JSON Lines to stdout.

Protocol:
  Request:  {"id": "req-1", "transcript": "user spoken text"}
  Response: {"id": "req-1", "text": "rewritten prompt"}
  Error:    {"id": "req-1", "error": "reason"}
"""

import sys
import json

MODEL_ID = "mlx-community/Llama-3.2-3B-Instruct-4bit"
MAX_TOKENS = 512

SYSTEM_PROMPT = (
    "You are a prompt rewriter for an AI coding assistant. "
    "Convert the user's spoken transcript into a clear, well-structured prompt. "
    "Rules:\n"
    "- Keep the user's intent exactly. Do not add requests they did not make.\n"
    "- Fix grammar and remove filler words (ähm, halt, irgendwie, sozusagen).\n"
    "- Structure with short bullet points if there are multiple distinct parts; otherwise plain prose.\n"
    "- Preserve the original language (German stays German, English stays English).\n"
    "- Output ONLY the rewritten prompt. No preamble, no explanation, no quotation marks."
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

    sys.stderr.write(f"[rewriter-sidecar] Loading model {MODEL_ID}...\n")
    sys.stderr.flush()
    model, tokenizer = load(MODEL_ID)
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
            text = (output or "").strip()
            if not text:
                text = transcript
            print(json.dumps({"id": req_id, "text": text}))
        except Exception as e:
            sys.stderr.write(f"[rewriter-sidecar] Error on {req_id}: {e}\n")
            sys.stderr.flush()
            print(json.dumps({"id": req_id, "error": str(e)}))


if __name__ == "__main__":
    main()
