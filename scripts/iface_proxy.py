#!/usr/bin/env python3
"""TCP proxy that binds outbound traffic to a specific NIC.

Usage:
  iface_proxy.py --listen 127.0.0.1:19001 --target 192.168.100.1:9200 \
    [--interface wlan0] [--local-address 192.168.1.10]

Linux: binds by interface NAME with SO_BINDTODEVICE (allowed for unprivileged
users on Linux >= 5.7, so no root/CAP_NET_RAW is needed). The interface's IP is
never pinned: both Wi-Fi links use DHCP, and a pinned source IP that the NIC no
longer holds fails every connect with EADDRNOTAVAIL ("Cannot assign requested
address") - that killed the Home feed for ~20 h on 2026-10-17.
If SO_BINDTODEVICE is refused, the interface's CURRENT IPv4 is looked up at
connect time (SIOCGIFADDR) and used as the source address instead.
--local-address is only used when no --interface is given (Windows/macOS).
Connect errors are logged at most once per minute per error, with a count.
"""
from __future__ import annotations

import argparse
import fcntl
import select
import socket
import struct
import sys
import threading
import time

SIOCGIFADDR = 0x8915
_log_lock = threading.Lock()
_log_state: dict[str, list] = {}   # key -> [last_print_ts, suppressed_count]


def log_limited(key: str, msg: str, every: float = 60.0) -> None:
    now = time.time()
    with _log_lock:
        st = _log_state.setdefault(key, [0.0, 0])
        if now - st[0] >= every:
            extra = f" (+{st[1]} similar in last {int(now - st[0])} s)" if st[1] and st[0] else ""
            print(msg + extra, file=sys.stderr, flush=True)
            st[0], st[1] = now, 0
        else:
            st[1] += 1


def parse_hostport(s: str) -> tuple[str, int]:
    host, _, port = s.rpartition(":")
    if not host or not port:
        raise ValueError(f"expected host:port, got {s!r}")
    return host, int(port)


def iface_ipv4(iface: str) -> str | None:
    """Current IPv4 of iface, or None if it has none (down / no DHCP lease)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        res = fcntl.ioctl(s.fileno(), SIOCGIFADDR, struct.pack("256s", iface.encode()[:15]))
        return socket.inet_ntoa(res[20:24])
    except OSError:
        return None
    finally:
        s.close()


_bindtodevice_ok: bool | None = None


def bind_outbound(iface: str | None, local_addr: str | None) -> socket.socket:
    global _bindtodevice_ok
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    if iface:
        if _bindtodevice_ok is not False:
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode() + b"\0")
                _bindtodevice_ok = True
                return sock
            except (AttributeError, OSError) as e:
                _bindtodevice_ok = False
                print(f"[iface_proxy] SO_BINDTODEVICE({iface}) unavailable: {e}; "
                      f"falling back to the interface's current IP", file=sys.stderr, flush=True)
        ip = iface_ipv4(iface)
        if not ip:
            sock.close()
            raise OSError(f"interface {iface} has no IPv4 address right now (down or no DHCP lease)")
        sock.bind((ip, 0))
        return sock
    if local_addr:
        sock.bind((local_addr, 0))
    return sock


def pipe(a: socket.socket, b: socket.socket) -> None:
    try:
        while True:
            r, _, _ = select.select([a, b], [], [], 60)
            if not r:
                continue
            for src, dst in ((a, b), (b, a)):
                if src in r:
                    data = src.recv(65536)
                    if not data:
                        return
                    dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass


def handle(client: socket.socket, target: tuple[str, int], iface: str | None, local_addr: str | None) -> None:
    upstream = None
    try:
        upstream = bind_outbound(iface, local_addr)
        upstream.settimeout(5)
        upstream.connect(target)
        upstream.settimeout(None)
    except OSError as e:
        log_limited(f"connect:{type(e).__name__}:{getattr(e, 'errno', '')}",
                    f"[iface_proxy] connect {target} via iface={iface or '-'} failed: {e}")
        if upstream is not None:
            upstream.close()
        client.close()
        return
    pipe(client, upstream)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--interface", default="")
    ap.add_argument("--local-address", default="")
    args = ap.parse_args()

    listen = parse_hostport(args.listen)
    target = parse_hostport(args.target)
    iface = args.interface or None
    local_addr = None if iface else (args.local_address or None)
    if iface and args.local_address:
        print(f"[iface_proxy] ignoring --local-address {args.local_address}: binding by interface {iface} instead",
              flush=True)

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(listen)
    server.listen(32)
    print(
        f"[iface_proxy] {args.listen} -> {args.target} iface={iface or '-'} local={local_addr or '-'} "
        f"(current {iface} IPv4: {iface_ipv4(iface) if iface else '-'})",
        flush=True,
    )

    while True:
        client, _ = server.accept()
        threading.Thread(
            target=handle, args=(client, target, iface, local_addr), daemon=True
        ).start()


if __name__ == "__main__":
    raise SystemExit(main())
