/**
 * Body parsing for the API routers. express.json/express.raw on their own
 * answer an over-limit Content-Length only after draining the whole declared
 * body (body-parser's `dump`), so a client that declares 5 MB and sends
 * nothing holds the socket until the request timeout. Such requests are
 * refused before a byte of body is read and the connection is closed.
 * Compressed bodies are refused as well (415): no client sends them, and
 * inflating one is work done for free (for the webhook, work done before the
 * signature check).
 */
import express, { type RequestHandler } from "express";

function guarded(limit: number, parse: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (Number(req.headers["content-length"]) > limit) {
      res.set("Connection", "close");
      next(Object.assign(new Error("request entity too large"), { status: 413, type: "entity.too.large", expose: true }));
      return;
    }
    parse(req, res, next);
  };
}

/** express.json with `limit` in bytes; errors go to the router's body error handler like the parser's own. */
export function jsonBody(limit: number): RequestHandler {
  return guarded(limit, express.json({ limit, inflate: false }));
}

/** express.raw for any content type (a Buffer on req.body) with `limit` in bytes and the same guards as jsonBody. */
export function rawBody(limit: number): RequestHandler {
  return guarded(limit, express.raw({ type: () => true, limit, inflate: false }));
}
