export function sessionDiagnosticsCommand(paneId: string, socketPath: string): string {
  return `python3 - <<'REMODR_SESSION_DIAGNOSTICS'
import json, os, socket, sys
from pathlib import Path
pane = ${JSON.stringify(paneId)}
socket_path = os.path.expanduser(${JSON.stringify(socketPath)})
def rpc(method, params):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(socket_path)
        request = {"id": "remodr-diagnostics", "method": method, "params": params}
        connection.sendall((json.dumps(request) + "\\n").encode())
        return json.loads(connection.makefile("r").readline())
response = rpc("pane.process_info", {"pane_id": pane})
if "error" in response:
    raise RuntimeError(response["error"].get("message", "Process information unavailable"))
info = response["result"]["process_info"]
native_response = rpc("agent.get", {"target": pane})
if "error" in native_response:
    raise RuntimeError(native_response["error"].get("message", "Agent information unavailable"))
native = native_response["result"]["agent"]
processes = []
for process in info.get("foreground_processes", []):
    argv = process.get("argv", [])
    script = argv[1] if len(argv) > 1 and isinstance(argv[1], str) else ""
    item = {
        "pid": process.get("pid"), "name": process.get("name"),
        "argv0": process.get("argv0"),
        "script": script if script.startswith("/") and (script.endswith(".js") or script.endswith("/copilot")) else None,
        "launcherPaths": [arg for arg in argv if isinstance(arg, str) and arg.startswith("/") and ("copilot" in arg or arg.endswith(".js"))],
    }
    pid = process.get("pid")
    if sys.platform.startswith("linux") and type(pid) is int and pid > 0:
        try:
            directory = Path("/proc") / str(pid)
            item["executable"] = os.readlink(directory / "exe")
            fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
            item["parentPid"], item["processGroup"] = int(fields[1]), int(fields[2])
            root = (Path.home() / ".copilot/session-state").resolve()
            sessions = set()
            for index, fd in enumerate((directory / "fd").iterdir()):
                if index >= 4096:
                    raise OSError("Descriptor inspection limit exceeded")
                try:
                    path = Path(os.readlink(fd))
                except FileNotFoundError:
                    continue
                if path.name == "session.db" and path.parent.parent == root:
                    sessions.add(path.parent.name)
            item["openSessionIds"] = sorted(sessions)
        except OSError as error:
            item["inspectionError"] = type(error).__name__
    processes.append(item)
print(json.dumps({
    "platform": sys.platform, "uid": os.getuid(), "pane": info.get("pane_id"),
    "nativeSession": native.get("agent_session"),
    "foregroundGroup": info.get("foreground_process_group_id"),
    "shellPid": info.get("shell_pid"), "processes": processes,
}, indent=2))
REMODR_SESSION_DIAGNOSTICS`;
}
