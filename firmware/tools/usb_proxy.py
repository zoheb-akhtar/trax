#!/usr/bin/env python3
"""Tiny HTTP/HTTPS proxy so the UNO Q can reach the internet through the Mac over USB.
Run on the Mac, then:  adb reverse tcp:8899 tcp:8899   (board uses http://127.0.0.1:8899)"""
import asyncio, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899

async def pipe(r, w):
    try:
        while data := await r.read(65536):
            w.write(data); await w.drain()
    except Exception:
        pass
    finally:
        try: w.close()
        except Exception: pass

async def handle(cr, cw):
    try:
        head = await cr.readuntil(b"\r\n\r\n")
    except Exception:
        cw.close(); return
    line = head.split(b"\r\n", 1)[0].decode("latin1")
    method, target, ver = line.split(" ", 2)
    try:
        if method == "CONNECT":
            host, port = target.rsplit(":", 1)
            ur, uw = await asyncio.open_connection(host, int(port))
            cw.write(b"HTTP/1.1 200 Connection established\r\n\r\n"); await cw.drain()
        else:
            rest = target.split("://", 1)[1]
            hostport, _, path = rest.partition("/")
            host, _, port = hostport.partition(":")
            ur, uw = await asyncio.open_connection(host, int(port or 80))
            lines = head.split(b"\r\n")
            lines[0] = f"{method} /{path} {ver}".encode()
            lines = [l for l in lines if not l.lower().startswith(b"proxy-")]
            uw.write(b"\r\n".join(lines)); await uw.drain()
    except Exception as e:
        print("fail", line, e, flush=True)
        cw.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n"); cw.close(); return
    print(method, target, flush=True)
    await asyncio.gather(pipe(cr, uw), pipe(ur, cw))

async def main():
    srv = await asyncio.start_server(handle, "127.0.0.1", PORT)
    print(f"proxy on 127.0.0.1:{PORT}", flush=True)
    async with srv: await srv.serve_forever()

asyncio.run(main())
