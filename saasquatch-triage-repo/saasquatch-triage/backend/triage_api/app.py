"""FastAPI app. Thin by design: the scoring engine runs in the browser so a slider
drag re-ranks instantly and lead data never has to leave the user's machine.
The server does only what a browser cannot: DNS/MX checks, and saving lists.

Run locally:  uvicorn triage_api.app:app --reload   (from backend/)
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .domain_check import MAX_BATCH, DomainChecker
from .ratelimit import RateLimiter
from .storage import Store

DB_PATH = os.getenv("TRIAGE_DB_PATH", "triage.db")
CORS_ORIGINS = [o.strip() for o in os.getenv("TRIAGE_CORS_ORIGINS", "*").split(",") if o.strip()]
FRONTEND_DIR = Path(os.getenv("TRIAGE_FRONTEND_DIR", Path(__file__).resolve().parents[2] / "frontend"))

store = Store(DB_PATH)
checker = DomainChecker(store)
limiter = RateLimiter(rate_per_sec=2.0, burst=20)  # ~20 batches up front, then 2/s

app = FastAPI(title="Triage API", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type"])


class DomainCheckRequest(BaseModel):
    domains: list[str] = Field(..., min_length=1, max_length=MAX_BATCH)


class SaveListRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    thesis: dict
    leads: list[dict] = Field(..., max_length=20_000)


def _client(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "unknown")


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method != "GET":
        if not limiter.allow(_client(request)):
            return JSONResponse({"detail": "Too many requests. Wait a few seconds and try again."}, status_code=429)
    return await call_next(request)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "dns_mode": checker.mode, "cache_ttl_days": checker.ttl / 86400}


@app.post("/api/domains/check")
def check_domains(body: DomainCheckRequest) -> dict:
    return checker.check(body.domains)


@app.get("/api/lists")
def get_lists() -> dict:
    return {"lists": store.list_lists()}


@app.post("/api/lists", status_code=201)
def save_list(body: SaveListRequest) -> dict:
    return store.save_list(body.name.strip(), body.thesis, body.leads)


@app.get("/api/lists/{list_id}")
def get_list(list_id: str) -> dict:
    found = store.get_list(list_id)
    if found is None:
        raise HTTPException(404, "List not found")
    return found


@app.delete("/api/lists/{list_id}", status_code=204)
def delete_list(list_id: str) -> None:
    if not store.delete_list(list_id):
        raise HTTPException(404, "List not found")


# Serve the single-page frontend from the same origin so local setup is one command.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
