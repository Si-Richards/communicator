#!/usr/bin/env python3
"""Locate the running Linux binary installation without exposing its environment."""
import os
from pathlib import Path
import re
import sys


def argument(args, flag):
    try:
        return args[args.index(flag) + 1]
    except (ValueError, IndexError):
        return None


def discover(ctl, node, proc_root=Path("/proc")):
    install_root = Path(ctl).resolve().parent.parent
    matches = []
    for process in proc_root.iterdir():
        if not process.name.isdecimal():
            continue
        try:
            executable = (process / "exe").resolve(strict=True)
            if executable.name not in ("beam.smp", "beam"):
                continue
            if install_root not in executable.parents:
                continue
            args = [os.fsdecode(v) for v in (process / "cmdline").read_bytes().split(b"\0") if v]
            process_node = argument(args, "-sname") or argument(args, "-name")
            if process_node not in (node, node.split("@", 1)[0]):
                continue
            environment = dict(v.split(b"=", 1) for v in (process / "environ").read_bytes().split(b"\0") if b"=" in v)
            home = argument(args, "-home") or os.fsdecode(environment.get(b"HOME", b""))
            contrib = os.fsdecode(environment.get(b"CONTRIB_MODULES_PATH", b""))
            if not contrib:
                if not home:
                    raise ValueError("The running node has no discoverable home; its module path cannot be inferred.")
                contrib = str(Path(home) / ".ejabberd-modules")
            if not Path(contrib).is_absolute() or any(c in contrib for c in "\r\n\t"):
                raise ValueError("The running node's contribution-module path must be an absolute, single-line path.")
            status = (process / "status").read_text()
            uid = re.search(r"^Uid:\s+\d+\s+(\d+)", status, re.MULTILINE)
            gid = re.search(r"^Gid:\s+\d+\s+(\d+)", status, re.MULTILINE)
            if not uid or not gid:
                raise ValueError("Cannot resolve the running node's effective owner.")
            matches.append((contrib, uid.group(1), gid.group(1)))
        except (PermissionError, FileNotFoundError, ProcessLookupError):
            # Unrelated processes may be inaccessible or disappear during a scan.
            continue
    if len(matches) != 1:
        raise ValueError("Cannot uniquely locate the running node in this Linux installation. Run as root on the ejabberd host and check the ejabberdctl path.")
    return matches[0]


if __name__ == "__main__":
    try:
        node = re.search(r"^The node (\S+) is ", sys.argv[2], re.MULTILINE)
        if not node:
            raise ValueError("Cannot resolve the node name from ejabberdctl status.")
        for value in discover(sys.argv[1], node.group(1)):
            print(value)
    except (OSError, ValueError, IndexError):
        # Never print command lines, environment contents or exception payloads.
        print("Cannot resolve the running node's module path and owner. Run as root on the Linux ejabberd host using the running installation's ejabberdctl.", file=sys.stderr)
        sys.exit(1)
