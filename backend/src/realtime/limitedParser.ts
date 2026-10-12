/**
 * Socket.IO parser that refuses oversized and binary packets and caps how
 * many packets and bytes one connection may send.
 *
 * Socket.IO's maxHttpBufferSize is enforced by the `ws` package's maxPayload
 * for WebSocket frames. Under Bun, `ws` is replaced by Bun's own
 * implementation, which ignores maxPayload, so a client could send events of
 * any size over WebSocket. Checking in the decoder covers every transport:
 * a throw here makes Socket.IO close that client's connection before the
 * event reaches any handler.
 *
 * Binary packets are refused outright. The protocol never sends binary, and
 * socket.io-parser trusts the attachment count in a BINARY_EVENT/BINARY_ACK
 * header, buffering every following binary frame until that many arrive. A
 * client could announce a million attachments and send small frames until
 * the process runs out of memory, before any middleware or rate limit runs.
 *
 * The per-event buckets (rateLimit.ts) only see events with a handler. Every
 * packet is JSON-parsed before that, so a client sending unknown events or
 * acks at wire speed would cost CPU with no limit; Socket.IO creates one
 * Decoder per connection, so the budgets below are per connection and the
 * connection is closed when one runs out.
 */
import { Decoder, Encoder, PacketType } from "socket.io-parser";
import { PACKET_BYTES_PER_CONNECTION, PACKET_RATE_PER_CONNECTION, TokenBucket } from "../rateLimit";

const BINARY_TYPES = new Set([String(PacketType.BINARY_EVENT), String(PacketType.BINARY_ACK)]);

export function limitedParser(maxBytes: number, now: () => number = Date.now) {
  class LimitedDecoder extends Decoder {
    private readonly packets = new TokenBucket(PACKET_RATE_PER_CONNECTION, now());
    private readonly bytes = new TokenBucket(PACKET_BYTES_PER_CONNECTION, now());

    add(chunk: unknown): void {
      if (typeof chunk !== "string") throw new Error("binary packets are not supported");
      if (BINARY_TYPES.has(chunk.charAt(0))) throw new Error("binary packets are not supported");
      const size = Buffer.byteLength(chunk);
      if (size > maxBytes) throw new Error(`packet of ${size} bytes exceeds ${maxBytes}`);
      const at = now();
      if (!this.packets.take(at)) throw new Error("packet rate exceeded");
      if (!this.bytes.take(at, size)) throw new Error("byte rate exceeded");
      super.add(chunk);
    }
  }
  return { Encoder, Decoder: LimitedDecoder };
}
