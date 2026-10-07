#!/usr/bin/env python3
"""Pull LUSCA's corpus export (GET /api/export/*) to this PC. Python 3.9+ standard library only.

What it does, every run:
  1. reads the export token: env LUSCA_EXPORT_TOKEN, else the LUSCA_EXPORT_TOKEN line of --secrets
     (default C:/Users/PC/.studio/secrets.env). The token is never printed or logged.
  2. fetches the manifest (waits up to --wait-complete seconds while the server is still hashing / building)
  3. downloads every artifact that is new or changed (sha256 differs from the last verified copy) into --out
     (default C:/lusca-codex/corpus), web-text archives first because the server deletes them on rotation
  4. verifies size and sha256 against the manifest, then renames into place (atomic); a broken download is
     resumed next time with an HTTP Range request; nothing unchanged is downloaded again
  5. never deletes local files: archives the server has pruned stay here
  6. appends to <out>/pull.log, writes <out>/manifest.json and <out>/state.json, and exits

Layout under --out:   web/dataset-<stamp>.jsonl           rotated web-text archives (PII-redacted at ingest)
                      code-index/*.jsonl.gz, index.json    protocol code index shards and state
                      kept-code/files|contracts|idls-NNNNNN.jsonl.gz, refs.jsonl.gz, current.jsonl.gz

Usage:
  python scripts/codex/pull_corpus.py                       # pull everything new from https://lusca.ink
  python scripts/codex/pull_corpus.py --dry-run             # list what would be pulled
  python scripts/codex/pull_corpus.py --only web,kept-code  # limit to these top-level directories
  python scripts/codex/pull_corpus.py --init-token          # add a fresh LUSCA_EXPORT_TOKEN to --secrets (not printed)

Hourly on Windows (Task Scheduler):
  schtasks /Create /SC HOURLY /TN "LUSCA corpus pull" /TR "py -3 C:\\path\\to\\scripts\\codex\\pull_corpus.py"

Exit codes: 0 every listed artifact is present and verified (or skipped by --only), 1 fatal (token, auth,
network, disk, another run holds the lock), 2 some artifacts failed or were not ready (retried next run).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import http.client as httpclient
import json
import os
import re
import secrets
import shutil
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

USER_AGENT = "lusca-corpus-puller/1"
DEFAULT_BASE = "https://lusca.ink"
DEFAULT_OUT = "C:/lusca-codex/corpus"
DEFAULT_SECRETS = "C:/Users/PC/.studio/secrets.env"
TOKEN_KEY = "LUSCA_EXPORT_TOKEN"
PART_RE = re.compile(r"^[A-Za-z0-9._-]{1,200}$")
TOP_DIRS = ("web", "code-index", "kept-code")
ORDER = {"web": 0, "kept-code": 1, "code-index": 2}
CHUNK = 1 << 20
LOCK_STALE_S = 3 * 3600


class Fatal(Exception):
    pass


class Log:
    def __init__(self, file: Path | None):
        self.file = file

    def __call__(self, level: str, msg: str) -> None:
        line = f"{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} {level:<5} {msg}"
        print(line, flush=True)
        if self.file:
            try:
                with self.file.open("a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError:
                pass


# ─── token ───────────────────────────────────────────────────────────────────


def read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return out
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def load_token(secrets_path: Path) -> str:
    tok = os.environ.get(TOKEN_KEY, "").strip()
    if not tok:
        tok = read_env_file(secrets_path).get(TOKEN_KEY, "").strip()
    if not tok:
        raise Fatal(f"{TOKEN_KEY} is not set in the environment or in {secrets_path}")
    if len(tok) < 32:
        raise Fatal(f"{TOKEN_KEY} is shorter than 32 characters; the server refuses such tokens")
    return tok


def init_token(secrets_path: Path, log: Log) -> int:
    if read_env_file(secrets_path).get(TOKEN_KEY, "").strip():
        log("info", f"{TOKEN_KEY} already present in {secrets_path}; left unchanged")
        return 0
    secrets_path.parent.mkdir(parents=True, exist_ok=True)
    existing = secrets_path.read_bytes().decode("utf-8", "replace") if secrets_path.exists() else ""
    eol = "\r\n" if "\r\n" in existing else "\n"  # keep the file's own line endings
    sep = "" if (not existing or existing.endswith("\n")) else eol
    with secrets_path.open("a", encoding="utf-8", newline="") as f:
        f.write(f"{sep}{TOKEN_KEY}={secrets.token_urlsafe(48)}{eol}")
    log("info", f"added {TOKEN_KEY} to {secrets_path} (value not shown); set the same value on the server")
    return 0


# ─── http ────────────────────────────────────────────────────────────────────


class Http:
    def __init__(self, base: str, token: str, timeout: float, log: Log):
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.log = log

    def open(self, path: str, headers: dict[str, str] | None = None):
        """Returns the response for 200 / 206 / 304; raises urllib.error.HTTPError otherwise."""
        req = urllib.request.Request(self.base + path, method="GET")
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("User-Agent", USER_AGENT)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        return urllib.request.urlopen(req, timeout=self.timeout)

    def with_retries(self, what: str, fn, attempts: int = 5):
        """fn() with retries on 429 / 503 (Retry-After) and network errors. 401 / 403 are fatal."""
        delay = 5.0
        for i in range(attempts):
            try:
                return fn()
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    raise Fatal(f"{what}: HTTP {e.code} (token rejected or locked out)") from None
                if e.code in (429, 503) and i < attempts - 1:
                    wait = retry_after(e.headers.get("Retry-After"), delay)
                    self.log("info", f"{what}: HTTP {e.code}, retrying in {wait:.0f} s")
                    time.sleep(wait)
                    delay = min(delay * 2, 120)
                    continue
                raise
            except (urllib.error.URLError, socket.timeout, ConnectionError, TimeoutError, httpclient.HTTPException) as e:
                if i < attempts - 1:
                    self.log("info", f"{what}: {reason(e)}, retrying in {delay:.0f} s")
                    time.sleep(delay)
                    delay = min(delay * 2, 120)
                    continue
                raise Fatal(f"{what}: {reason(e)}") from None
        raise Fatal(f"{what}: gave up")


def retry_after(v: str | None, default: float) -> float:
    try:
        return max(1.0, min(float(v or default), 300.0))
    except ValueError:
        return default


def reason(e: BaseException) -> str:
    r = getattr(e, "reason", None)
    return str(r if r is not None else e) or type(e).__name__


# ─── files ───────────────────────────────────────────────────────────────────


def sha256_file(path: Path, upto: int | None = None) -> "hashlib._Hash":
    h = hashlib.sha256()
    left = upto
    with path.open("rb") as f:
        while True:
            n = CHUNK if left is None else min(CHUNK, left)
            if n == 0:
                break
            b = f.read(n)
            if not b:
                break
            h.update(b)
            if left is not None:
                left -= len(b)
    return h


def write_json_atomic(path: Path, value) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(value, f, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def safe_dest(out: Path, rel: str) -> Path | None:
    parts = rel.split("/")
    if len(parts) != 2 or parts[0] not in TOP_DIRS or not PART_RE.match(parts[1]) or parts[1] in (".", ".."):
        return None
    return out / parts[0] / parts[1]


class Lock:
    def __init__(self, path: Path):
        self.path = path
        self.held = False

    def __enter__(self):
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w") as f:
                    f.write(f"{os.getpid()} {dt.datetime.now(dt.timezone.utc).isoformat()}\n")
                self.held = True
                return self
            except FileExistsError:
                try:
                    age = time.time() - self.path.stat().st_mtime
                except OSError:
                    continue
                if age > LOCK_STALE_S:
                    self.path.unlink(missing_ok=True)
                    continue
                raise Fatal(f"another pull is running ({self.path} is {age / 60:.0f} min old)")
        raise Fatal(f"could not take {self.path}")

    def __exit__(self, *exc):
        if self.held:
            self.path.unlink(missing_ok=True)


# ─── pulling ─────────────────────────────────────────────────────────────────


def fetch_manifest(http: Http, wait_complete: float, log: Log) -> dict:
    deadline = time.time() + max(0.0, wait_complete)
    while True:

        def get():
            with http.open("/api/export/manifest", {"Accept-Encoding": "gzip"}) as r:
                body = r.read()
                if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
                    body = zlib.decompress(body, 16 + zlib.MAX_WBITS)
                return json.loads(body.decode("utf-8"))

        try:
            m = http.with_retries("manifest", get)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise Fatal("manifest: HTTP 404 (export not enabled on the server, or wrong --base)") from None
            raise Fatal(f"manifest: HTTP {e.code}") from None
        if not isinstance(m, dict) or m.get("v") != 1 or not isinstance(m.get("artifacts"), list):
            raise Fatal("manifest: unexpected format")
        if m.get("complete") or time.time() >= deadline:
            return m
        log("info", f"manifest: server still preparing {len(m.get('pending') or [])} artifact(s); waiting 30 s")
        time.sleep(30)


def download(http: Http, art: dict, dest: Path, log: Log) -> str:
    """Download one artifact into dest. Returns 'ok', 'changed' (412: newer than the manifest) or 'gone'; raises
    ValueError when the bytes do not verify and OSError / HTTPError on transfer errors (the .part is kept for a
    resume when it can be)."""
    rel, want_sha, size = art["path"], art["sha256"], int(art["bytes"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    meta = dest.with_name(dest.name + ".part.json")
    if part.exists():
        try:
            pm = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pm = {}
        if pm.get("sha256") != want_sha or part.stat().st_size > size:
            part.unlink(missing_ok=True)  # a different version, or garbage: start over
    meta.write_text(json.dumps({"sha256": want_sha, "path": rel}), encoding="utf-8")
    etag = f'"{want_sha}"'
    plain = rel.endswith(".jsonl") or rel.endswith(".json")

    def finish() -> str:
        have = part.stat().st_size
        got = sha256_file(part).hexdigest()
        if have != size or got != want_sha:
            part.unlink(missing_ok=True)
            meta.unlink(missing_ok=True)
            raise ValueError(f"{rel}: verification failed (bytes {have} vs {size}, sha256 {got[:12]}... vs {want_sha[:12]}...)")
        os.replace(part, dest)
        meta.unlink(missing_ok=True)
        return "ok"

    def go() -> str:
        offset = part.stat().st_size if part.exists() else 0
        if offset == size and size > 0:
            return finish()  # complete from an earlier run that stopped before the rename
        headers = {"If-Match": etag}
        if offset > 0:
            headers["Range"] = f"bytes={offset}-"  # resume: always the plain bytes
            headers["If-Range"] = etag
        elif plain:
            headers["Accept-Encoding"] = "gzip"
        with http.open(f"/api/export/file/{urllib.parse.quote(rel)}", headers) as r:
            mode = "ab"
            if r.status == 206:
                m = re.match(r"bytes (\d+)-(\d+)/(\d+)", r.headers.get("Content-Range") or "")
                if not m or int(m.group(1)) != offset:
                    part.unlink(missing_ok=True)
                    raise ValueError(f"{rel}: unexpected Content-Range {r.headers.get('Content-Range')}")
            elif r.status == 200:
                if offset:
                    log("info", f"{rel}: server sent the whole file instead of resuming")
                mode = "wb"
            else:
                raise ValueError(f"{rel}: unexpected HTTP {r.status}")
            dec = zlib.decompressobj(16 + zlib.MAX_WBITS) if (r.headers.get("Content-Encoding") or "").lower() == "gzip" else None
            with part.open(mode) as f:
                while True:
                    b = r.read(CHUNK)
                    if not b:
                        break
                    if dec:
                        b = dec.decompress(b)
                    if b:
                        f.write(b)
                if dec:
                    f.write(dec.flush())
                f.flush()
                os.fsync(f.fileno())
                if dec and not dec.eof:
                    raise ConnectionError("gzip stream ended early")
        return finish()

    try:
        return http.with_retries(rel, go, attempts=4)
    except urllib.error.HTTPError as e:
        if e.code == 412:
            return "changed"
        if e.code in (404, 410):
            part.unlink(missing_ok=True)
            meta.unlink(missing_ok=True)
            return "gone"
        if e.code == 416:
            part.unlink(missing_ok=True)
        raise


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Pull LUSCA's corpus export to this PC.")
    ap.add_argument("--base", default=os.environ.get("LUSCA_EXPORT_BASE", DEFAULT_BASE))
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--secrets", default=DEFAULT_SECRETS)
    ap.add_argument("--only", default="", help="comma list of top-level dirs: web, kept-code, code-index")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--wait-complete", type=float, default=300.0, help="seconds to wait for a complete manifest")
    ap.add_argument("--max-gb", type=float, default=0.0, help="stop after downloading this much (0 = no cap)")
    ap.add_argument("--reserve-gb", type=float, default=5.0, help="free disk space to keep on --out's drive")
    ap.add_argument("--timeout", type=float, default=120.0, help="socket timeout, seconds")
    ap.add_argument("--init-token", action="store_true", help=f"add a new {TOKEN_KEY} to --secrets if missing")
    a = ap.parse_args(argv)

    out = Path(a.out)
    secrets_path = Path(a.secrets)
    if a.init_token:
        return init_token(secrets_path, Log(None))
    out.mkdir(parents=True, exist_ok=True)
    log = Log(out / "pull.log")
    only = {s.strip() for s in a.only.split(",") if s.strip()}
    if only - set(TOP_DIRS):
        log("error", f"--only accepts {', '.join(TOP_DIRS)}")
        return 1
    t0 = time.time()
    try:
        token = load_token(secrets_path)
        http = Http(a.base, token, a.timeout, log)
        with Lock(out / ".pull.lock"):
            return pull(http, out, only, a, log, t0)
    except Fatal as e:
        log("error", str(e))
        return 1
    except KeyboardInterrupt:
        log("error", "interrupted; partial downloads resume next run")
        return 1


def pull(http: Http, out: Path, only: set[str], a, log: Log, t0: float) -> int:
    m = fetch_manifest(http, a.wait_complete, log)
    write_json_atomic(out / "manifest.json", m)
    state_file = out / "state.json"
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
        if not isinstance(state, dict) or not isinstance(state.get("artifacts"), dict):
            raise ValueError
    except (OSError, ValueError):
        state = {"version": 1, "artifacts": {}}
    known: dict = state["artifacts"]

    arts = [x for x in m["artifacts"] if isinstance(x, dict) and isinstance(x.get("path"), str)]
    arts.sort(key=lambda x: (ORDER.get(x["path"].split("/")[0], 9), x["path"]))
    pulled = unchanged = failed = skipped = 0
    pulled_bytes = 0
    cap = int(a.max_gb * (1 << 30)) if a.max_gb > 0 else 0
    for art in arts:
        rel = art["path"]
        top = rel.split("/")[0]
        if only and top not in only:
            skipped += 1
            continue
        dest = safe_dest(out, rel)
        sha, size = str(art.get("sha256", "")), art.get("bytes")
        if dest is None or not re.fullmatch(r"[0-9a-f]{64}", sha) or not isinstance(size, int) or size < 0:
            log("warn", f"skipping malformed manifest row {rel!r}")
            failed += 1
            continue
        prev = known.get(rel)
        if dest.exists() and dest.stat().st_size == size:
            if prev and prev.get("sha256") == sha:
                unchanged += 1
                continue
            if sha256_file(dest).hexdigest() == sha:  # copied in by hand, or state.json lost
                known[rel] = {"sha256": sha, "bytes": size, "kind": art.get("kind"), "savedAt": prev.get("savedAt") if prev else None}
                unchanged += 1
                continue
        if a.dry_run:
            log("info", f"would pull {rel} ({size / 1e6:.1f} MB)")
            pulled += 1
            pulled_bytes += size
            continue
        if cap and pulled_bytes + size > cap:
            log("info", f"--max-gb reached; {rel} and later artifacts wait for the next run")
            failed += 1
            break
        free = shutil.disk_usage(out).free
        if free - size < a.reserve_gb * (1 << 30):
            raise Fatal(f"not enough disk space for {rel} ({size / 1e9:.2f} GB; {free / 1e9:.1f} GB free, reserve {a.reserve_gb} GB)")
        t = time.time()
        try:
            r = download(http, art, dest, log)
        except (ValueError, urllib.error.HTTPError, OSError) as e:
            log("warn", str(e) if isinstance(e, ValueError) else f"{rel}: {reason(e)}")
            failed += 1
            continue
        if r == "ok":
            known[rel] = {"sha256": sha, "bytes": size, "kind": art.get("kind"), "savedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
            write_json_atomic(state_file, state)
            pulled += 1
            pulled_bytes += size
            secs = max(0.001, time.time() - t)
            log("info", f"pulled {rel} | {size / 1e6:.1f} MB | {size / 1e6 / secs:.1f} MB/s | sha256 ok")
        elif r == "changed":
            log("info", f"{rel} changed on the server since the manifest; next run")
            failed += 1
        else:
            log("info", f"{rel} is no longer on the server")
    write_json_atomic(state_file, state)
    pending = len(m.get("pending") or [])
    log(
        "info",
        f"done in {time.time() - t0:.0f} s: {'would pull' if a.dry_run else 'pulled'} {pulled} ({pulled_bytes / 1e6:.1f} MB), "
        f"unchanged {unchanged}, failed {failed}, not ready on the server {pending}" + (f", skipped by --only {skipped}" if skipped else ""),
    )
    return 2 if failed or pending else 0


if __name__ == "__main__":
    sys.exit(main())
