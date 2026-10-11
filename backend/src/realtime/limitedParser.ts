/**
 * Socket.IO parser that refuses oversized and binary packets.
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
 */
import { Decoder, Encoder, PacketType } from "socket.io-parser";

const BINARY_TYPES = new Set([String(PacketType.BINARY_EVENT), String(PacketType.BINARY_ACK)]);

export function limitedParser(maxBytes: number) {
  class LimitedDecoder extends Decoder {
    add(chunk: unknown): void {
      if (typeof chunk !== "string") throw new Error("binary packets are not supported");
      if (BINARY_TYPES.has(chunk.charAt(0))) throw new Error("binary packets are not supported");
      const size = Buffer.byteLength(chunk);
      if (size > maxBytes) throw new Error(`packet of ${size} bytes exceeds ${maxBytes}`);
      super.add(chunk);
    }
  }
  return { Encoder, Decoder: LimitedDecoder };
}
