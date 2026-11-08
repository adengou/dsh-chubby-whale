
import sys, json, asyncio, threading, queue


def main():
    try:
        import edge_tts
    except Exception as e:
        print(json.dumps({"ready": False, "error": repr(e)}), flush=True)
        return
    print(json.dumps({"ready": True}), flush=True)

    # Protocol (B95):
    #   request  {"id": N, "text": .., "voice": .., "rate": .., "pitch": .., "out": ..}
    #   cancel   {"cancel": N}                      written by the host on abort
    #   ack      {"id": N, "cancelled": true, "active": bool}
    #   result   {"id": N, "ok": true|false, "error": ..}
    # Boundary: edge_tts stream() blocks while awaiting the next websocket chunk, so the
    # stop flag is only observed *after* that chunk arrives. The ack is immediate (sent by
    # the reader thread) but the actual stop may lag by one chunk / the connection timeout.
    lock = threading.Lock()       # guards cancelled + state
    out_lock = threading.Lock()   # two threads write stdout; keep each line whole
    reqs = queue.Queue()
    cancelled = {}
    state = {"id": None, "ev": None}

    def emit(obj):
        with out_lock:
            print(json.dumps(obj), flush=True)

    def take_cancel(cid):
        with lock:
            cancelled[cid] = True
            while len(cancelled) > 512:
                cancelled.pop(next(iter(cancelled)))
            ev = state["ev"] if state["id"] == cid else None
        if ev is not None:
            ev.set()
        emit({"id": cid, "cancelled": True, "active": ev is not None})

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            if "cancel" in msg:
                cid = msg.get("cancel")
                if isinstance(cid, int) and not isinstance(cid, bool):
                    take_cancel(cid)
                continue
            reqs.put(msg)
        reqs.put(None)

    threading.Thread(target=reader, daemon=True).start()

    async def synth(req, out, ev):
        c = edge_tts.Communicate(
            req.get("text") or "",
            req.get("voice") or "zh-CN-XiaoyiNeural",
            rate=req.get("rate") or "+0%",
            pitch=req.get("pitch") or "+0Hz",
        )
        stream = c.stream()
        try:
            with open(out, "wb") as f:
                async for chunk in stream:
                    if ev.is_set():
                        break
                    if chunk.get("type") == "audio":
                        f.write(chunk.get("data") or b"")
        finally:
            # close the websocket now instead of waiting for GC
            try:
                await stream.aclose()
            except Exception:
                pass

    while True:
        req = reqs.get()
        if req is None:
            return
        rid = req.get("id")
        if not isinstance(rid, int) or isinstance(rid, bool):
            continue
        ev = threading.Event()
        with lock:
            state["id"] = rid
            state["ev"] = ev
            stale = cancelled.pop(rid, False)
        if stale:
            # cancelled before it started: write nothing, answer nothing (ack already sent)
            with lock:
                if state["id"] == rid:
                    state["id"] = None
                    state["ev"] = None
            continue
        try:
            asyncio.run(synth(req, str(req.get("out") or ""), ev))
        except Exception as e:
            if not ev.is_set():
                emit({"id": rid, "ok": False, "error": repr(e)})
        else:
            if not ev.is_set():
                emit({"id": rid, "ok": True})
        finally:
            with lock:
                if state["id"] == rid:
                    state["id"] = None
                    state["ev"] = None


main()
