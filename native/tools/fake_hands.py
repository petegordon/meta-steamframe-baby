#!/usr/bin/env python3
"""Pretend to be the Steam Frame hand tracker, for testing Frame Hands without
the real one (on a desktop, or on the Frame to check the app itself works).

Speaks the tracker's protocol (FhHandPacket v3, UDP 47811): waits for the app's
subscribe ping, then streams two hands at 60 Hz. The right hand sweeps across
the buttons and makes a fist every 2 s; the left hand opens and closes slowly.

    python3 fake_hands.py            # then start the app
"""
import math
import socket
import struct
import time

MAGIC, PORT = 0x444E4846, 47811
HEAD = struct.Struct("<IIQQII")        # magic, version, seq, tCapNs, mode, flags
HAND = struct.Struct("<If3f4ff5f5f")   # valid, conf, pos[3], quat w,x,y,z, ageMs, curl[5], splay[5]


def quat_yaw_pitch(yaw, pitch):
    """Rotation = yaw about +y, then pitch about +x. Returns (w, x, y, z)."""
    cy, sy = math.cos(yaw / 2), math.sin(yaw / 2)
    cp, sp = math.cos(pitch / 2), math.sin(pitch / 2)
    return (cy * cp, cy * sp, sy * cp, -sy * sp)


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", PORT))
    sock.setblocking(False)
    subs = {}
    seq = 0
    t0 = time.monotonic()
    print("fake hand tracker on UDP %d: waiting for the app to subscribe" % PORT)
    while True:
        try:
            while True:
                data, addr = sock.recvfrom(64)
                if len(data) >= 12 and struct.unpack_from("<III", data) == (MAGIC, 3, 1):
                    if addr not in subs:
                        print("subscriber", addr)
                    subs[addr] = time.monotonic()
        except BlockingIOError:
            pass
        now = time.monotonic()
        subs = {a: t for a, t in subs.items() if now - t < 5}
        t = now - t0
        seq += 1
        # Right hand: sweep left-right, aimed a bit up at the button board; fist every 2 s.
        fist = 1.0 if (t % 2.0) > 1.4 else 0.1
        right = HAND.pack(1, 0.9, 0.17, -0.24, -0.42, *quat_yaw_pitch(0.25 * math.sin(t * 0.7), 0.26),
                          15.0, 0.3, fist, fist, fist, fist, *[0.0] * 5)
        c = 0.5 - 0.5 * math.cos(t * 1.3)
        left = HAND.pack(1, 0.9, -0.2, -0.28 + 0.03 * math.sin(t), -0.38, *quat_yaw_pitch(0.3, -0.35),
                         15.0, c * 0.6, c * 0.4, c * 0.4, c * 0.4, c * 0.4, *[0.0] * 5)
        pkt = HEAD.pack(MAGIC, 3, seq, time.monotonic_ns(), 1, 0x80000003) + left + right
        for a in subs:
            try:
                sock.sendto(pkt, a)
            except OSError:
                pass
        time.sleep(1 / 60)


if __name__ == "__main__":
    main()
