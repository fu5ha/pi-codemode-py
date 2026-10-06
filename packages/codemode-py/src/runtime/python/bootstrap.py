"""Embedded startup and lifecycle bootstrap; no runtime asset lookup."""
import sys

if sys.version_info < (3, 12):
    raise RuntimeError("codemode requires Python 3.12+ on PATH as python3")

import os
import socket
import struct
import json


def establish_cleanup():
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IOCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
        )]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimits),
            ("IoInfo", IOCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    # NULL security attributes make the handle non-inheritable. Descendants join
    # the job, but cannot hold its last handle open after the runner is killed.
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    try:
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            raise ctypes.WinError(ctypes.get_last_error())
    except BaseException:
        kernel.CloseHandle(job)
        raise
    # Deliberately keep this handle open until OS process teardown, not Python
    # finalizers; closing it while we're in the job also terminates this process.
    return job


_cleanup_job = establish_cleanup()
# The host starts POSIX runners as new process-group leaders. Remember the
# original group for bridge-loss cleanup, before trusted user code runs.
_cleanup_group = os.getpgrp() if os.name != "nt" else None
_bridge = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
_bridge.sendall((sys.argv[2] + "\n").encode("ascii"))


def read_frame():
    def read_exact(size):
        chunks = bytearray()
        while len(chunks) < size:
            chunk = _bridge.recv(size - len(chunks))
            if not chunk:
                raise EOFError("codemode bridge closed")
            chunks.extend(chunk)
        return bytes(chunks)
    size = struct.unpack("!I", read_exact(4))[0]
    if size > 64 * 1024 * 1024:
        raise ValueError("codemode bridge frame exceeds 64 MiB")
    return json.loads(read_exact(size))


_bootstrap = read_frame()
_config = _bootstrap["data"]
try:
    exec(compile(_bootstrap["runner"], "<codemode-runner>", "exec"), globals())
except BaseException as error:
    # Backend failures are distinct from script errors. Keep the process alive
    # after sending so the host can consume the frame before socket teardown.
    import threading
    _failure = json.dumps({"type": "crash", "message": f"Execution worker failed: {type(error).__name__}: {error}"}).encode("utf-8")
    _bridge.sendall(struct.pack("!I", len(_failure)) + _failure)
    threading.Event().wait()
