import hashlib
import json
import os
from pathlib import Path
import sys
import zipfile

state_file = Path(os.environ["SYNC_INSTALL_FIXTURE"])
state = json.loads(state_file.read_text(encoding="utf-8"))
tool, *arguments = sys.argv[1:]


def save():
    state_file.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def fail(message):
    print(message, file=sys.stderr)
    save()
    sys.exit(1)


if tool == "gh":
    destination = Path(arguments[arguments.index("--dir") + 1])
    archive = Path(state["archive"]).read_bytes()
    (destination / "settings-sync.zip").write_bytes(archive)
    expected = "0" * 64 if state.get("bad_checksum") else hashlib.sha256(archive).hexdigest()
    (destination / "SHA256SUMS").write_text(expected + "  settings-sync.zip\n", encoding="utf-8")
    sys.exit(0)
if tool == "unzip":
    with zipfile.ZipFile(arguments[1]) as archive:
        archive.extractall(arguments[arguments.index("-d") + 1])
    sys.exit(0)

if "--home" not in arguments or Path(arguments[arguments.index("--home") + 1]).resolve() != Path(state["home"]).resolve():
    fail("The installer did not explicitly select the fixture home")
arguments = arguments[:arguments.index("--home")]
state["calls"].append(arguments)
current = state["current"]
if arguments[:2] == ["plugin", "ls"]:
    save()
    if state.get("bad_json"):
        print("not-json")
    else:
        print(json.dumps(state.get("other_plugins", []) + ([current] if current else []), ensure_ascii=False))
elif arguments[:3] == ["daemon", "config", "get"]:
    save()
    print(json.dumps({"value": state["global"]}))
elif arguments[:3] == ["daemon", "config", "set"]:
    if arguments[3] != "pluginsEnabled":
        fail("Unexpected configuration mutation")
    state["global"] = arguments[4] == "true"
    save()
    print("{}")
elif arguments[:2] == ["plugin", "remove"]:
    if state.get("fail_remove"):
        fail("synthetic removal failure before mutation")
    if current and current.get("installation", {}).get("identity", {}).get("kind") in ("git", "npm"):
        managed = Path(state["home"]) / "plugins" / "settings-sync"
        if managed.exists():
            managed.rename(managed.with_name("settings-sync-preserved-by-fixture"))
    state["current"] = None
    save()
    print("{}")
elif arguments[:2] == ["plugin", "install"]:
    if current:
        fail("Plugin ID settings-sync is already configured")
    directory = Path(arguments[2]).resolve()
    if not (directory / "paseo-plugin.json").is_file():
        fail("Missing plugin code")
    new_code = (directory / "code-marker").read_text(encoding="utf-8") == "new-code"
    entry = {"id": "settings-sync", "path": str(directory), "enabled": True, "status": "running" if state["global"] else "disabled", "installation": {"identity": {"kind": "directory"}}}
    if new_code and state.get("fail_install") == "before":
        fail("synthetic install failure before mutation")
    if new_code and state.get("fail_install") == "foreign":
        entry["path"] = state["foreign"]
        state["current"] = entry
        fail("synthetic install failure with a concurrent replacement")
    state["current"] = entry
    if new_code and state.get("fail_install") == "after":
        entry["status"] = "failed"
        fail("synthetic install failure after registration")
    save()
    print("Trusting synthetic plugin code", file=sys.stderr)
    print(json.dumps(entry, ensure_ascii=False))
elif arguments[:2] in (["plugin", "disable"], ["plugin", "reload"]):
    if not current:
        fail("Missing plugin")
    if arguments[1] == "disable":
        current["enabled"] = False
        current["status"] = "disabled"
    else:
        current["status"] = "running"
    save()
    print("{}")
else:
    fail("Unexpected CLI command: " + " ".join(arguments))
