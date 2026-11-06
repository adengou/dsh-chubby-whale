
import sys, json, asyncio

def main():
    try:
        import edge_tts
    except Exception as e:
        print(json.dumps({"ready": False, "error": repr(e)}), flush=True)
        return
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        out = req.get("out") or ""
        try:
            async def run():
                c = edge_tts.Communicate(
                    req.get("text") or "",
                    req.get("voice") or "zh-CN-XiaoyiNeural",
                    rate=req.get("rate") or "+0%",
                    pitch=req.get("pitch") or "+0Hz",
                )
                await c.save(out)
            asyncio.run(run())
            print(json.dumps({"id": rid, "ok": True}), flush=True)
        except Exception as e:
            print(json.dumps({"id": rid, "ok": False, "error": repr(e)}), flush=True)

main()
