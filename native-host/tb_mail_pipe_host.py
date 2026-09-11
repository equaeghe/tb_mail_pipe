#!/usr/bin/env python3
"""
Native messaging host for the "Thunderbird Mail Pipe" Thunderbird addon.

Protocol: standard WebExtension native messaging framing on stdin/stdout -
each message is a 4-byte little-endian length prefix followed by that many
bytes of UTF-8 JSON.

Request (from the addon):
    {
        "action": "run",
        "steps": [
            {"command": "/absolute/path/to/script1", "argv": []},
            {"command": "/absolute/path/to/script2", "argv": ["--flag"]},
            ...
        ],
        "stdinBase64": "<base64 of the raw RFC822 message>",
        "timeoutMs": 30000
    }
Steps run in order, each one's stdout feeding the next one's stdin (an
addon-orchestrated pipe chain, equivalent to `script1 | script2 | ...` in a
shell), sharing one overall timeout budget across all steps.

Response (to the addon):
    {"ok": true, "exitCode": 0, "stdoutBase64": "...", "stderr": "..."}
    {"ok": false, "error": "human readable message"}

On success, "stdoutBase64"/"exitCode"/"stderr" refer to the last step. If a
step in the middle of the chain exits non-zero, the chain stops there and
those fields refer to the failing step instead (with "stderr" prefixed by
which step failed).

Security note: every step's command must be listed, by absolute path, in
the allow-list file (see ALLOWLIST_PATH below), and ALL steps are
validated before ANY of them run - so a bug or compromise in the
browser-side extension cannot be used to execute arbitrary commands, and a
chain never partially executes just because a later step turns out to be
disallowed.
"""

import base64
import json
import os
import struct
import subprocess
import sys
import time
import traceback
from pathlib import Path

ALLOWLIST_PATH = Path(
    os.environ.get(
        "TB_MAIL_PIPE_ALLOWLIST",
        str(Path.home() / ".config" / "tb-mail-pipe" / "allowed-scripts.json"),
    )
)

LOG_PATH = Path(
    os.environ.get(
        "TB_MAIL_PIPE_LOG",
        str(Path.home() / ".local" / "state" / "tb-mail-pipe" / "host.log"),
    )
)


def log(msg: str) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(msg.rstrip("\n") + "\n")
    except Exception:
        # Logging must never crash the host.
        pass


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None  # EOF: browser closed the pipe.
    (length,) = struct.unpack("<I", raw_length)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(obj) -> None:
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def load_allowlist():
    if not ALLOWLIST_PATH.exists():
        return []
    try:
        with ALLOWLIST_PATH.open("r", encoding="utf-8") as f:
            entries = json.load(f)
        if not isinstance(entries, list):
            return []
        return [str(Path(e).resolve()) for e in entries]
    except Exception as e:
        log(f"Failed to read allowlist {ALLOWLIST_PATH}: {e}")
        return []


def validate_steps(steps):
    """Resolve and check every step against the allow-list before anything
    runs. Returns (resolved_steps, None) on success, or (None, error_str)."""
    if not isinstance(steps, list) or len(steps) == 0:
        return None, "'steps' must be a non-empty list."

    allowlist = load_allowlist()
    resolved = []
    for i, step in enumerate(steps):
        command = step.get("command") if isinstance(step, dict) else None
        if not command:
            return None, f"Step {i + 1}: missing 'command'."

        command_resolved = str(Path(command).resolve())
        if command_resolved not in allowlist:
            return None, (
                f"Step {i + 1}: script '{command_resolved}' is not in the "
                f"allow-list ({ALLOWLIST_PATH}). Add its absolute path there first."
            )
        if not os.access(command_resolved, os.X_OK):
            return None, f"Step {i + 1}: script '{command_resolved}' is not executable."

        argv = step.get("argv") or []
        if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
            return None, f"Step {i + 1}: 'argv' must be a list of strings."

        resolved.append({"command": command_resolved, "argv": argv})

    return resolved, None


def handle_run(req):
    resolved_steps, error = validate_steps(req.get("steps"))
    if error:
        return {"ok": False, "error": error}

    stdin_b64 = req.get("stdinBase64", "")
    try:
        current_input = base64.b64decode(stdin_b64)
    except Exception as e:
        return {"ok": False, "error": f"Invalid base64 in 'stdinBase64': {e}"}

    timeout_ms = req.get("timeoutMs") or 30000
    deadline = time.monotonic() + max(1, int(timeout_ms)) / 1000.0

    last_exit_code = 0
    last_stderr = ""

    for i, step in enumerate(resolved_steps):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"ok": False, "error": f"Chain timed out before step {i + 1} could run."}

        try:
            proc = subprocess.run(
                [step["command"]] + step["argv"],
                input=current_input,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=remaining,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"Step {i + 1} timed out (chain budget exhausted)."}
        except Exception as e:
            return {"ok": False, "error": f"Step {i + 1}: failed to launch script: {e}"}

        last_exit_code = proc.returncode
        last_stderr = proc.stderr.decode("utf-8", errors="replace")
        current_input = proc.stdout

        if proc.returncode != 0:
            prefix = f"[step {i + 1}/{len(resolved_steps)}: {step['command']}] "
            return {
                "ok": True,
                "exitCode": proc.returncode,
                "stdoutBase64": base64.b64encode(current_input).decode("ascii"),
                "stderr": prefix + last_stderr,
            }

    return {
        "ok": True,
        "exitCode": last_exit_code,
        "stdoutBase64": base64.b64encode(current_input).decode("ascii"),
        "stderr": last_stderr,
    }


def main():
    try:
        message = read_message()
    except Exception as e:
        log(f"Failed to read native message: {e}\n{traceback.format_exc()}")
        send_message({"ok": False, "error": f"Failed to read request: {e}"})
        return

    if message is None:
        return  # nothing to do, browser closed immediately

    try:
        action = message.get("action")
        if action == "run":
            response = handle_run(message)
        else:
            response = {"ok": False, "error": f"Unknown action '{action}'."}
    except Exception as e:
        log(f"Unhandled error: {e}\n{traceback.format_exc()}")
        response = {"ok": False, "error": f"Internal host error: {e}"}

    send_message(response)


if __name__ == "__main__":
    main()
