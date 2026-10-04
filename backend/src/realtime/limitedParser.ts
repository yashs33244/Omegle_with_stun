/**
 * Socket.IO parser that refuses oversized packets.
 *
 * Socket.IO's maxHttpBufferSize is enforced by the `ws` package's maxPayload
 * for WebSocket frames. Under Bun, `ws` is replaced by Bun's own
 * implementation, which ignores maxPayload, so a client could send events of
 * any size over WebSocket. Checking in the decoder covers every transport:
 * a throw here makes Socket.IO close that client's connection before the
 * event reaches any handler.
 */
import { Decoder, Encoder } from "socket.io-parser";

export function limitedParser(maxBytes: number) {
  class LimitedDecoder extends Decoder {
    add(chunk: unknown): void {
      const size =
        typeof chunk === "string"
          ? Buffer.byteLength(chunk)
          : chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)
            ? chunk.byteLength
            : 0;
      if (size > maxBytes) throw new Error(`packet of ${size} bytes exceeds ${maxBytes}`);
      super.add(chunk);
    }
  }
  return { Encoder, Decoder: LimitedDecoder };
}
