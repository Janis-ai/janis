#!/usr/bin/env python3
"""Janis-specific Devin hooks (the trunk-based rules live globally in
~/.config/devin/hooks/tbd_guard.py; this adds the repo's deploy discipline).

  PreToolUse(exec)  block raw `gcloud run deploy` — deploy-gcp.sh carries
                    load-bearing flags (--no-cpu-throttling, secrets,
                    pre-deploy migrate, probe/rollback)
  SessionStart      remember when this session began
  Stop              if a deploy started during this session hasn't printed
                    `Deployed:` yet, don't let the turn end claiming it's
                    live — either it's still running (wait) or it died
                    (read the log)
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

LOG = "/tmp/janis-deploy.log"
STARTED = re.compile(r"^--- deploy started (\S+) ---")
DONE = re.compile(r"^(Deployed: |POST-DEPLOY PROBE FAILED|another deploy-gcp\.sh is already running)")


def marker(session_id):
    return f"/tmp/devin-janis-session-{session_id}.start"


def deploy_running():
    try:
        out = subprocess.run(["pgrep", "-f", "deploy-gcp.sh"], capture_output=True, text=True, timeout=3).stdout
        return bool(out.strip())
    except Exception:
        return False


def last_deploy():
    """(started_at datetime, finished bool) for the most recent run, or None."""
    try:
        lines = open(LOG, errors="replace").read().splitlines()[-2000:]
    except FileNotFoundError:
        return None
    started = None
    finished = False
    for line in lines:
        m = STARTED.match(line)
        if m:
            started = datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            finished = False
        elif started and DONE.match(line):
            finished = True
    return (started, finished) if started else None


def main():
    data = json.load(sys.stdin)
    event = data.get("hook_event_name")
    sid = data.get("session_id") or "unknown"

    if event == "PreToolUse" and data.get("tool_name") == "exec":
        cmd = (data.get("tool_input") or {}).get("command") or ""
        if re.search(r"\bgcloud\s+run\s+(deploy|services\s+update)\b", cmd):
            print(json.dumps({"decision": "block", "reason":
                              "Never deploy by hand — run ./scripts/deploy-gcp.sh (background, then watch "
                              "/tmp/janis-deploy.log). A manual deploy drops --no-cpu-throttling, secrets wiring, "
                              "the pre-deploy migration and the probe/rollback."}))
        return

    if event == "SessionStart":
        with open(marker(sid), "w") as f:
            f.write(datetime.now(timezone.utc).isoformat())
        return

    if event == "Stop" and not data.get("stop_hook_active"):
        try:
            session_start = datetime.fromisoformat(open(marker(sid)).read().strip())
        except Exception:
            return
        last = last_deploy()
        if not last or last[1] or last[0] < session_start:
            return
        if deploy_running():
            reason = (f"A deploy started {last[0].strftime('%H:%M:%SZ')} is still running. Don't report it as live — "
                      "wait for `Deployed:` in /tmp/janis-deploy.log and confirm the revision is serving 100%.")
        else:
            reason = (f"The deploy started {last[0].strftime('%H:%M:%SZ')} never printed `Deployed:` and no deploy-gcp.sh "
                      "is running — it failed (preflight? build? migrate?). Read the log tail and fix or tell the user; "
                      "do not describe the change as deployed.")
        print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(f"janis_guard error: {e}\n")
        sys.exit(1)
