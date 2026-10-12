/**
 * JSON body parsing for the API routers. express.json on its own answers an
 * over-limit Content-Length only after draining the whole declared body
 * (body-parser's `dump`), so a client that declares 5 MB and sends nothing
 * holds the socket until the request timeout. Such requests are refused
 * before a byte of body is read and the connection is closed. Compressed
 * bodies are refused as well (415): no client sends them, and inflating one
 * is work done for free.
 */
import express, { type RequestHandler } from "express";

/** express.json with `limit` in bytes; errors go to the router's body error handler like the parser's own. */
export function jsonBody(limit: number): RequestHandler {
  const parse = express.json({ limit, inflate: false });
  return (req, res, next) => {
    if (Number(req.headers["content-length"]) > limit) {
      res.set("Connection", "close");
      next(Object.assign(new Error("request entity too large"), { status: 413, type: "entity.too.large", expose: true }));
      return;
    }
    parse(req, res, next);
  };
}
