"""Trusted async Python execution and host tool bridge."""
import ast
import asyncio
import base64
import difflib
import io
import linecache
import pickle
import re
import signal
import threading
import traceback
from types import SimpleNamespace

MAX_OUTPUT_CHARS = _config["limits"]["outputChars"]
MAX_OUTPUT_ITEMS = _config["limits"]["outputItems"]
MAX_STORE_VALUE_BYTES = _config["limits"]["storeValueBytes"]
MAX_STORE_TOTAL_BYTES = _config["limits"]["storeTotalBytes"]
_send_lock = threading.Lock()
_output_chars = 0
_output_items = 0
_output_error = None
_finished = False
_futures = {}
_next_id = 0
_writes = {}
_store = {key: base64.b64decode(value, validate=True) for key, value in _config["store"].items()}
_store_size = sum(map(len, _store.values()))


def send(message):
    data = json.dumps(message, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("codemode bridge frame exceeds 64 MiB")
    with _send_lock:
        _bridge.sendall(struct.pack("!I", len(data)) + data)


def emit(item):
    global _output_chars, _output_items, _output_error
    if _finished:
        return
    chars = len(item["text"] if item["type"] == "text" else item["data"])
    if _output_error or _output_chars + chars > MAX_OUTPUT_CHARS or _output_items >= MAX_OUTPUT_ITEMS:
        _output_error = ValueError("script output exceeded the output limits")
        # Host fails immediately, even if user code catches ValueError and spins.
        send({"type": "overflow"})
        raise _output_error
    _output_chars += chars
    _output_items += 1
    send({"type": "output", "item": item})


def text(value):
    if not isinstance(value, str):
        try:
            value = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        except (TypeError, ValueError, OverflowError):
            value = repr(value)
    emit({"type": "text", "text": value})


def image(value):
    if isinstance(value, dict):
        if "image_url" in value:
            value = value["image_url"]
        else:
            if value.get("type") != "image":
                raise TypeError("image only accepts MCP image blocks")
            data = value.get("data")
            if not isinstance(data, str) or not data:
                raise TypeError("image expected MCP image data")
            value = "data:image/unknown;base64," + data
    if not isinstance(value, str) or not value:
        raise TypeError("image expects a non-empty image URL string, an object with image_url, or a raw MCP image block")
    if not value.startswith("data:"):
        raise TypeError("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead")
    match = re.fullmatch(r"data:[^;,]+;base64,(.*)", value, flags=re.DOTALL)
    if not match:
        raise TypeError("invalid image output. Pass a base64 data URI instead")
    data = re.sub(r"\s", "", match[1])
    try:
        raw = base64.b64decode(data, validate=True)
        if not raw or base64.b64encode(raw).decode("ascii") != data:
            raise ValueError()
    except (ValueError, base64.binascii.Error):
        raise TypeError("invalid image output. The image data is not valid base64 (truncated or corrupted?)") from None
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    elif raw.startswith(b"\xff\xd8\xff") and len(raw) >= 4 and raw[3] in range(0xC0, 0xFF) and raw[3] != 0xF7:
        mime = "image/jpeg"
    elif raw.startswith((b"GIF87a", b"GIF89a")):
        mime = "image/gif"
    elif raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        mime = "image/webp"
    else:
        raise TypeError("invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image")
    emit({"type": "image", "data": data, "mimeType": mime})


class ScriptExit(BaseException):
    pass


def send_done(message):
    global _finished
    if not _finished:
        _finished = True
        send(message)


def store_writes():
    return json.dumps([[key] if value is None else [key, value] for key, value in _writes.items()])


def exit():
    # Report success before unwinding, like the upstream helper. Even an
    # `except BaseException` cannot convert exit() into continued execution.
    sys.stdout.flush()
    sys.stderr.flush()
    send_done({"type": "done", "ok": True, "value": "null", "writes": store_writes()})
    raise ScriptExit()


def store(key, value):
    global _store_size
    if not isinstance(key, str):
        raise TypeError("store key must be a string")
    if value is None:
        _store_size -= len(_store.pop(key, b""))
        _writes[key] = None
        return
    raw = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
    if len(raw) > MAX_STORE_VALUE_BYTES:
        raise ValueError(f"store({key!r}) value has {len(raw)} pickle bytes; limit is {MAX_STORE_VALUE_BYTES}. Show images with image() instead")
    total = _store_size - len(_store.get(key, b"")) + len(raw)
    if total > MAX_STORE_TOTAL_BYTES:
        raise ValueError(f"store total exceeds {MAX_STORE_TOTAL_BYTES} pickle bytes")
    _store_size = total
    _store[key] = raw
    _writes[key] = base64.b64encode(raw).decode("ascii")


def load(key):
    if not isinstance(key, str):
        raise TypeError("load key must be a string")
    raw = _store.get(key)
    return None if raw is None else pickle.loads(raw)


class OutputStream(io.TextIOBase):
    def __init__(self):
        self.pending = ""

    @property
    def encoding(self):
        return "utf-8"

    def writable(self):
        return True

    def write(self, value):
        self.pending += value
        # Limit partial lines too; a print without a newline cannot bypass limits.
        if len(self.pending) > MAX_OUTPUT_CHARS:
            emit({"type": "text", "text": self.pending})
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            text(line.rstrip("\r"))
        return len(value)

    def flush(self):
        if self.pending:
            value, self.pending = self.pending, ""
            text(value)


def wrapper(name, target, spread=False):
    async def call(*args):
        global _next_id
        if _finished:
            raise ScriptExit()
        # Round-trip before dispatch: unsupported arguments never start a call.
        payload = list(args) if spread else (args[0] if args else None)
        payload = json.dumps(payload, allow_nan=False)
        _next_id += 1
        call_id = _next_id
        future = asyncio.get_running_loop().create_future()
        _futures[call_id] = future
        try:
            send({"type": "call", "id": call_id, "target": target, "name": name, "args": payload})
            return await future
        finally:
            _futures.pop(call_id, None)
            if future.cancelled():
                send({"type": "cancel", "id": call_id})
    return call


class Tools:
    def __init__(self, definitions):
        self._exact = {}
        self._aliases = {}
        for definition in definitions:
            call = wrapper(definition["name"], "tool")
            self._exact[definition["name"]] = call
            self._aliases[definition["scriptName"]] = call

    def __getattr__(self, name):
        if name in self._aliases:
            return self._aliases[name]
        matches = difflib.get_close_matches(name.lower(), [key.lower() for key in self._aliases], n=1, cutoff=0.6)
        hint = ""
        if matches:
            actual = next(key for key in self._aliases if key.lower() == matches[0])
            hint = f" Did you mean tools.{actual}?"
        raise AttributeError(f"tools.{name} does not exist.{hint} ALL_TOOLS lists every tool. Available: {', '.join(self._aliases)}.")

    def __getitem__(self, name):
        return self._exact[name]

    def __contains__(self, name):
        return name in self._exact or name in self._aliases

    def __iter__(self):
        return iter(self._aliases)


def complete(message):
    try:
        if (not isinstance(message, dict) or message.get("type") != "result"
                or type(message.get("id")) is not int or type(message.get("ok")) is not bool
                or not isinstance(message.get("payload"), str)):
            raise ValueError("invalid host result message")
        value = json.loads(message["payload"]) if message["ok"] else message["payload"]
        future = _futures.get(message["id"])
        if future is None or future.done():
            return
        if message["ok"]:
            future.set_result(value)
        else:
            future.set_exception(RuntimeError(value))
    except BaseException as error:
        send_done({"type": "crash", "message": f"Invalid host result: {error}"})


def receive(loop):
    try:
        while True:
            message = read_frame()
            loop.call_soon_threadsafe(complete, message)
    except BaseException:
        # A lost host/bridge must not leave trusted code or descendants running.
        # This daemon thread also detects abrupt host death while normal Python
        # code is spinning; it is lifecycle cleanup, not a hostile-code defense.
        if _cleanup_group is not None:
            # There is no host left to perform graceful/forced escalation. Kill
            # the whole original process group, including SIGTERM-resistant
            # descendants; exiting only the runner would leave them orphaned.
            try:
                os.killpg(_cleanup_group, signal.SIGKILL)
            except OSError:
                pass
        os._exit(1)


def script_diagnostics(error):
    diagnostics = []
    seen = set()

    def collect(current):
        if id(current) in seen:
            return False
        seen.add(id(current))
        relation = None
        previous = current.__cause__
        if previous is not None:
            relation = "cause"
        elif not current.__suppress_context__ and current.__context__ is not None:
            previous = current.__context__
            relation = "context"
        if previous is not None and not collect(previous):
            relation = None
        frames = []
        for frame in traceback.extract_tb(current.__traceback__):
            if frame.filename == "codemode.py":
                item = {
                    "line": frame.lineno,
                    "source": linecache.getline("codemode.py", frame.lineno).rstrip("\r\n"),
                    "function": frame.name,
                }
                frames.append(item)
        if isinstance(current, SyntaxError) and current.filename == "codemode.py" and current.lineno:
            item = {
                "line": current.lineno,
                "source": linecache.getline("codemode.py", current.lineno).rstrip("\r\n"),
            }
            if current.offset and current.offset > 0:
                item["column"] = current.offset
            if current.end_offset and current.end_offset > 0:
                item["endColumn"] = current.end_offset
            frames.append(item)
        diagnostic = {"name": type(current).__name__, "message": str(current), "frames": frames}
        if relation:
            diagnostic["relation"] = relation
        diagnostics.append(diagnostic)
        return True

    collect(error)
    return diagnostics


def error_payload(error):
    return json.dumps({
        "name": type(error).__name__,
        "message": str(error),
        "stack": "".join(traceback.format_exception(error)),
        "diagnostics": script_diagnostics(error),
    })


def compile_script(code, namespace):
    linecache.cache["codemode.py"] = (len(code), None, code.splitlines(keepends=True), "codemode.py")
    # ast.parse accepts await/return nodes at module scope; compile validates
    # them only after we place the original nodes inside an async function.
    # Unlike physical-line indentation, this preserves multiline literals and
    # all submitted source locations without traceback offset corrections.
    tree = ast.parse(code, filename="codemode.py")
    function = ast.AsyncFunctionDef(
        name="__codemode_main__",
        args=ast.arguments(posonlyargs=[], args=[], vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]),
        body=tree.body or [ast.Pass(lineno=1, col_offset=0)],
        decorator_list=[],
        returns=None,
        type_comment=None,
        type_params=[],
        lineno=1,
        col_offset=0,
        end_lineno=max(1, len(code.splitlines())),
        end_col_offset=0,
    )
    tree.body = [function]
    ast.fix_missing_locations(tree)
    exec(compile(tree, "codemode.py", "exec"), namespace)
    return namespace["__codemode_main__"]


async def run():
    loop = asyncio.get_running_loop()
    threading.Thread(target=receive, args=(loop,), daemon=True).start()
    namespace = {
        "asyncio": asyncio,
        "tools": Tools(_config["tools"]),
        "ALL_TOOLS": [{"name": item["scriptName"], "description": item["description"]} for item in _config["tools"]],
        "text": text, "image": image, "exit": exit, "store": store, "load": load,
    }
    for definition in _config["globals"]:
        parts = definition["name"].split(".")
        call = wrapper(definition["name"], "global", definition["spread"])
        if len(parts) == 1:
            namespace[parts[0]] = call
        else:
            group = namespace.setdefault(parts[0], SimpleNamespace())
            setattr(group, parts[1], call)
    stdout, stderr = OutputStream(), OutputStream()
    original_stdout, original_stderr = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = stdout, stderr
    try:
        try:
            value = await compile_script(_config["code"], namespace)()
        except ScriptExit:
            value = None
        # No repr fallback for returned values. Give a useful script error.
        try:
            value = json.dumps(value, allow_nan=False)
        except (TypeError, ValueError, OverflowError) as error:
            raise TypeError("return value is not JSON-serializable; explicitly convert it to JSON-compatible values") from error
        result = {"type": "done", "ok": True, "value": value, "writes": store_writes()}
    except BaseException as error:
        result = {"type": "done", "ok": False, "error": error_payload(error)}
    finally:
        # Request task cancellation without yielding to their handlers before
        # reporting completion. A handler may block or spin synchronously,
        # starving any asyncio.wait timeout on this same event loop. The host
        # aborts pending calls and enforces the actual process cleanup bound.
        tasks = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        try:
            stdout.flush()
            stderr.flush()
        except BaseException as error:
            result = {"type": "done", "ok": False, "error": error_payload(error)}
        sys.stdout, sys.stderr = original_stdout, original_stderr
    if _output_error:
        result = {"type": "done", "ok": False, "error": error_payload(_output_error)}
    send_done(result)
    # The host owns process termination. Exiting immediately after sendall can
    # reset a socket while a large terminal frame is still queued on Windows.
    # Keep the job handle alive until the host has consumed the complete frame.
    await asyncio.Future()


asyncio.run(run())
