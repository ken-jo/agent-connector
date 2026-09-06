"""Deterministic local mock model provider for the host verification lane.

Zero-dependency (stdlib only). Speaks four wire APIs on one port so any host that
can be pointed at a custom endpoint gets a scripted model turn without an API key:
  POST /v1/chat/completions                 OpenAI chat  (SSE when stream=true)
  POST /v1/responses                        OpenAI Responses (SSE when stream=true)
  POST /v1/messages                         Anthropic Messages (SSE when stream=true)
  POST /v1beta/models/<m>:generateContent   Google Gemini (+ :streamGenerateContent, :countTokens)
  GET  /v1/models                           static list

Turn policy (per process):
  MOCK_CALLS  optional JSON list of forced calls [{"name","arguments"}], each fired
              on the first request whose tool list offers that tool (for hosts that
              gate MCP tools behind meta-tools such as tool_search / use_tool).
  then        call the first tool whose name contains MOCK_TARGET (default
              "acme_query") with {"sql": "select 1"}; if none, call a shell tool
              with "echo pong".
  after that  plain text "done".
Env: MOCK_PORT (8765), MOCK_TARGET, MOCK_CALLS, MOCK_CALL (single forced call),
     MOCK_DUMP (append every request body as JSON lines, to learn tool schemas).
Every request is logged to stderr: request N wire=<api> stream=<bool> tools=[...].
"""
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("MOCK_PORT", "8765"))
TARGET = os.environ.get("MOCK_TARGET", "acme_query")
N = {"n": 0, "called": False}


def log(msg):
    sys.stderr.write(msg + "\n"); sys.stderr.flush()


CALL = os.environ.get("MOCK_CALL")  # optional JSON {"name":..., "arguments":{...}} forced tool call
CALLS = json.loads(os.environ.get("MOCK_CALLS", "[]"))  # optional ordered list of forced calls, each fired on the first request offering its tool
N["i"] = 0
DUMP = os.environ.get("MOCK_DUMP")  # optional path: append every request body as JSON lines


def pick_tool(names):
    if N["i"] < len(CALLS):
        c = CALLS[N["i"]]
        if c["name"] in names:
            N["i"] += 1
            return c["name"], c["arguments"]
        return None, None
    if CALL:
        c = json.loads(CALL)
        return (c["name"], c["arguments"]) if c["name"] in names else (None, None)
    for n in names:
        if TARGET in n:
            return n, {"sql": "select 1"}
    for n in names:
        if n in ("exec_command", "shell", "bash", "Bash", "shell_command", "local_shell", "run_shell_command", "execute_command"):
            return n, ({"cmd": "echo pong"} if n == "exec_command" else {"command": "echo pong"})
    return None, None


def tool_names(body, wire):
    out = []
    for t in body.get("tools", []) or []:
        if wire == "gemini":
            for fd in t.get("functionDeclarations", []) or t.get("function_declarations", []) or []:
                out.append(fd.get("name"))
            continue
        if wire == "anthropic":
            out.append(t.get("name"))
        elif wire == "responses":
            out.append(t.get("name") or (t.get("function") or {}).get("name") or t.get("type"))
        else:
            out.append((t.get("function") or {}).get("name") or t.get("name"))
    return [x for x in out if x]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, data, ctype):
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(json.dumps({"object": "list", "data": [{"id": "mock-model", "object": "model", "owned_by": "mock"}]}).encode(), "application/json")

    def do_POST(self):
        ln = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(ln) or b"{}")
        if ":countTokens" in self.path:
            self._send(json.dumps({"totalTokens": 1}).encode(), "application/json"); return
        if ":generateContent" in self.path or ":streamGenerateContent" in self.path:
            wire = "gemini"
        elif "/responses" in self.path:
            wire = "responses"
        elif "/messages" in self.path:
            wire = "anthropic"
        else:
            wire = "chat"
        N["n"] += 1
        names = tool_names(body, wire)
        if DUMP:
            with open(DUMP, "a") as f:
                f.write(json.dumps(body) + "\n")
        log(f"request {N['n']} wire={wire} stream={bool(body.get('stream'))} tools={names}")
        tool, args = (None, None)
        if not N["called"]:
            before = N["i"]
            tool, args = pick_tool(names)
            if tool and N["i"] == before:
                N["called"] = True
        stream = bool(body.get("stream")) or ":streamGenerateContent" in self.path
        if wire == "gemini":
            self.gemini(tool, args, stream)
        elif wire == "chat":
            self.chat(tool, args, stream)
        elif wire == "responses":
            self.resp_api(tool, args, stream)
        else:
            self.anthropic(tool, args, stream)

    # ---- OpenAI chat completions
    def chat(self, tool, args, stream):
        if tool:
            msg = {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": tool, "arguments": json.dumps(args)}}]}
            finish = "tool_calls"
        else:
            msg = {"role": "assistant", "content": "done"}
            finish = "stop"
        if not stream:
            self._send(json.dumps({"id": "chatcmpl-mock", "object": "chat.completion", "created": 0, "model": "mock-model",
                                   "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
                                   "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode(), "application/json")
            return
        def chunk(delta, fin=None):
            return {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": 0, "model": "mock-model", "choices": [{"index": 0, "delta": delta, "finish_reason": fin}]}
        if tool:
            deltas = [chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": tool, "arguments": json.dumps(args)}}]}), chunk({}, "tool_calls")]
        else:
            deltas = [chunk({"role": "assistant", "content": "done"}), chunk({}, "stop")]
        out = "".join("data: " + json.dumps(c) + "\n\n" for c in deltas) + "data: [DONE]\n\n"
        self._send(out.encode(), "text/event-stream")

    # ---- OpenAI Responses API
    def resp_api(self, tool, args, stream):
        if tool:
            item = {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": tool, "arguments": json.dumps(args), "status": "completed"}
        else:
            item = {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "done", "annotations": []}]}
        resp = {"id": "resp_mock", "object": "response", "created_at": 0, "status": "completed", "model": "mock-model", "output": [item],
                "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
        if not stream:
            self._send(json.dumps(resp).encode(), "application/json"); return
        events = [("response.created", {"response": {**resp, "status": "in_progress", "output": []}}),
                  ("response.output_item.added", {"output_index": 0, "item": {**item, "status": "in_progress"} if tool else {**item, "content": []}})]
        if tool:
            events.append(("response.function_call_arguments.delta", {"output_index": 0, "item_id": "fc_1", "delta": json.dumps(args)}))
            events.append(("response.function_call_arguments.done", {"output_index": 0, "item_id": "fc_1", "arguments": json.dumps(args)}))
        else:
            events.append(("response.output_text.delta", {"output_index": 0, "content_index": 0, "item_id": "msg_1", "delta": "done"}))
            events.append(("response.output_text.done", {"output_index": 0, "content_index": 0, "item_id": "msg_1", "text": "done"}))
        events.append(("response.output_item.done", {"output_index": 0, "item": item}))
        events.append(("response.completed", {"response": resp}))
        out = ""
        for i, (typ, payload) in enumerate(events):
            out += "event: " + typ + "\ndata: " + json.dumps({"type": typ, "sequence_number": i, **payload}) + "\n\n"
        self._send(out.encode(), "text/event-stream")

    # ---- Google Gemini generateContent
    def gemini(self, tool, args, stream):
        part = {"functionCall": {"name": tool, "args": args}} if tool else {"text": "done"}
        resp = {"candidates": [{"content": {"parts": [part], "role": "model"}, "finishReason": "STOP", "index": 0}],
                "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
                "modelVersion": "mock-model", "responseId": "mock"}
        if not stream:
            self._send(json.dumps(resp).encode(), "application/json"); return
        self._send(("data: " + json.dumps(resp) + "\n\n").encode(), "text/event-stream")

    # ---- Anthropic Messages API
    def anthropic(self, tool, args, stream):
        if tool:
            block = {"type": "tool_use", "id": "toolu_1", "name": tool, "input": args}
            stop = "tool_use"
        else:
            block = {"type": "text", "text": "done"}
            stop = "end_turn"
        msg = {"id": "msg_mock", "type": "message", "role": "assistant", "model": "mock-model", "content": [block], "stop_reason": stop, "stop_sequence": None,
               "usage": {"input_tokens": 1, "output_tokens": 1}}
        if not stream:
            self._send(json.dumps(msg).encode(), "application/json"); return
        ev = [("message_start", {"message": {**msg, "content": [], "stop_reason": None}})]
        if tool:
            ev.append(("content_block_start", {"index": 0, "content_block": {"type": "tool_use", "id": "toolu_1", "name": tool, "input": {}}}))
            ev.append(("content_block_delta", {"index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(args)}}))
        else:
            ev.append(("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}}))
            ev.append(("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": "done"}}))
        ev.append(("content_block_stop", {"index": 0}))
        ev.append(("message_delta", {"delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 1}}))
        ev.append(("message_stop", {}))
        out = "".join("event: " + t + "\ndata: " + json.dumps({"type": t, **p}) + "\n\n" for t, p in ev)
        self._send(out.encode(), "text/event-stream")


if __name__ == "__main__":
    log(f"mock provider on 127.0.0.1:{PORT} target={TARGET}")
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
