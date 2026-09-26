# 场景：Boujoy 旧点号 RPC → 现代 DSH 斜杠 RPC + token/cookie 鉴权。
"""Translate Boujoy's legacy Harness RPC surface onto current dsh web APIs."""

from __future__ import annotations

import http.cookiejar
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

LOOPBACK = "127.0.0.1"

# Boujoy UI still speaks dotted methods; modern dsh web uses slash paths.
ENDPOINT_MAP: dict[str, str] = {
    "session.list": "session/list",
    "session.create": "session/create",
    "session.prompt": "session/prompt",
    "session.cancel": "session/cancel",
    "session.fork": "session/fork",
    "session.rename": "session/rename",
    "session.search": "session/search",
    "session.selectModel": "session/selectModel",
    "session.updateQueue": "session/updateQueue",
    "session.history": "session/page",
    "session.models": "session/modelCatalog",
    "workspace.create": "workspace/create",
    "workspace.delete": "workspace/delete",
    "workspace.rename": "workspace/rename",
    "workspace.insertBefore": "workspace/insertBefore",
    "workspace.archiveSession": "workspace/archiveSession",
    "host.pickDirectory": "directoryPicker/pick",
    "host.openPath": "session/openWorkspacePath",
    "llm.models": "llm/listProviders",
    "llm.providers": "llm/listProviders",
    "llm.discoverModels": "llm/discoverModels",
    "agentPreset.list": "agentPresets/list",
    "agentPreset.read": "agentPresets/read",
    "agentPreset.select": "agentPresets/select",
    "agentPreset.copy": "agentPresets/copy",
    "agentPreset.remove": "agentPresets/deletePreset",
    "agentPreset.openDocument": "settings/openAgentPresetDirectory",
    "credentials.describe": "credentials/describe",
    "credentials.set": "credentials/set",
    "credentials.unset": "credentials/unset",
    "goal.create": "goals/create",
    "goal.edit": "goals/edit",
    "settings.describe": "settings/describe",
    "settings.openDocument": "settings/openSettingsDocument",
    "settings.update": "settings/update",
    "skill.list": "skills/list",
    "subagent.list": "subagents/list",
    "subagent.prompt": "subagents/prompt",
    "subagent.interrupt": "subagents/interruptByParent",
    "commands/execute": "commands/execute",
    "events.mux": "remote.mux",
    "events.host": "remote.mux",
}

# Endpoints that wrap legacy payload fields inside `request` (not `_request`).
REQUEST_KEY_ENDPOINTS = {
    "session/create",
    "session/prompt",
    "session/cancel",
    "session/fork",
    "session/rename",
    "session/selectModel",
    "session/updateQueue",
    "session/page",
    "session/openWorkspacePath",
    "workspace/create",
    "workspace/delete",
    "workspace/rename",
    "workspace/insertBefore",
    "workspace/archiveSession",
    "goals/create",
    "goals/edit",
    "subagents/list",
    "subagents/prompt",
    "subagents/interruptByParent",
}


def compact_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def map_endpoint(legacy: str) -> str:
    if legacy in ENDPOINT_MAP:
        return ENDPOINT_MAP[legacy]
    if "/" in legacy:
        return legacy
    return legacy.replace(".", "/")


def wrap_payload_args(endpoint: str, payload: Any) -> dict[str, Any]:
    """Modern typert gateway requires payload.args with _request or request."""
    if not isinstance(payload, dict):
        payload = {}
    if "args" in payload and isinstance(payload["args"], dict):
        return payload
    key = "request" if endpoint in REQUEST_KEY_ENDPOINTS else "_request"
    # Already shaped.
    if key in payload and len(payload) == 1:
        return {"args": payload}
    if "_request" in payload or "request" in payload:
        return {"args": payload}
    return {"args": {key: payload}}


def rewrite_client_request_body(legacy_endpoint: str, body: bytes | None) -> tuple[str, bytes]:
    endpoint = map_endpoint(legacy_endpoint)
    if not body:
        wrapped = {
            "type": "client-request",
            "rpcId": "boujoy",
            "method": endpoint,
            "payload": wrap_payload_args(endpoint, {}),
        }
        return endpoint, compact_json(wrapped)
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return endpoint, body
    if not isinstance(parsed, dict):
        return endpoint, body
    payload = parsed.get("payload")
    parsed["method"] = endpoint
    parsed["payload"] = wrap_payload_args(endpoint, payload if isinstance(payload, dict) else {})
    return endpoint, compact_json(parsed)


def synthesize_workspaces_from_sessions(session_value: Any) -> dict[str, Any]:
    """Modern dsh has no workspace/list HTTP; derive folders from session cwd."""
    items: list[dict[str, Any]] = []
    if isinstance(session_value, dict):
        raw_items = session_value.get("items") or session_value.get("sessions") or []
    elif isinstance(session_value, list):
        raw_items = session_value
    else:
        raw_items = []
    by_cwd: dict[str, dict[str, Any]] = {}
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        session = raw.get("session") if isinstance(raw.get("session"), dict) else raw
        cwd = str(session.get("cwd") or session.get("path") or "").strip() or "(unknown)"
        sid = str(session.get("sessionId") or session.get("id") or "")
        bucket = by_cwd.get(cwd)
        if bucket is None:
            name = cwd.rstrip("/").split("/")[-1] if cwd not in {"", "(unknown)"} else "未命名项目"
            bucket = {
                "id": f"cwd:{cwd}",
                "workspaceId": f"cwd:{cwd}",
                "path": cwd,
                "cwd": cwd,
                "name": name,
                "title": name,
                "sessionIds": [],
            }
            by_cwd[cwd] = bucket
            items.append(bucket)
        if sid:
            bucket["sessionIds"].append(sid)
    return {"workspaces": items, "items": items, "archivedSessionIds": []}


def synthesize_host_describe() -> dict[str, Any]:
    return {
        "provider": "deepseek",
        "model": "-",
        "version": "dsh-web",
        "product": "DeepSeek Harness",
    }


class HarnessAuthSession:
    """Exchange dsh ?token= URL once, then attach Cookie on every upstream call."""

    def __init__(self, auth_url: str) -> None:
        self.auth_url = auth_url.strip()
        self._cookie = ""
        self._lock = __import__("threading").Lock()
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar),
            urllib.request.ProxyHandler({}),
        )

    def ensure_cookie(self) -> str:
        with self._lock:
            if self._cookie:
                return self._cookie
            if not self.auth_url:
                return ""
            request = urllib.request.Request(self.auth_url, method="GET")
            with self._opener.open(request, timeout=10) as response:
                response.read(64)
            parts = [f"{cookie.name}={cookie.value}" for cookie in self._jar]
            self._cookie = "; ".join(parts)
            return self._cookie

    def cookie_header(self) -> str:
        try:
            return self.ensure_cookie()
        except Exception:
            self._cookie = ""
            try:
                return self.ensure_cookie()
            except Exception:
                return ""


class HarnessEngine:
    def __init__(self, origin: str, auth_url: str = "") -> None:
        self.origin = origin.rstrip("/")
        self.auth = HarnessAuthSession(auth_url or origin + "/")
        parsed = urllib.parse.urlparse(self.origin)
        self.host = parsed.hostname or LOOPBACK
        self.port = int(parsed.port or 80)

    def open_upstream(self, path: str, timeout: float = 10) -> socket.socket:
        return socket.create_connection((self.host, self.port), timeout=timeout)


def build_engines(knowledge_origin: str, clean_origin: str, knowledge_auth: str, clean_auth: str) -> dict[str, HarnessEngine]:
    return {
        "knowledge": HarnessEngine(knowledge_origin, knowledge_auth or knowledge_origin),
        "clean": HarnessEngine(clean_origin, clean_auth or clean_origin),
    }


_TOKEN_RE = re.compile(r"https?://127\.0\.0\.1:\d+/\?token=[^\s\"']+")


def extract_auth_url_from_text(text: str, port: int) -> str | None:
    for match in _TOKEN_RE.finditer(text or ""):
        url = match.group(0)
        if f":{port}/" in url:
            return url
    return None
