import { useCallback, useEffect, useReducer, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL } from "@/lib/config";
import { getDeviceId } from "@/lib/device";
import { getSessionToken, invalidateSession, waitForSession } from "@/lib/session";
import {
  LIMITS,
  PROTOCOL_VERSION,
  helloSchema,
  type Ack,
  type ChatAck,
  type ClientToServerEvents,
  type ErrorCode,
  type HelloAck,
  type IceServer,
  type MatchEndReason,
  type MatchMode,
  type Preferences,
  type Profile,
  type PublicProfile,
  type ReportAck,
  type ReportPayload,
  type ReportReason,
  type RtcSignal,
  type ServerToClientEvents,
  type SimpleAck,
} from "@/lib/protocol";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/* ------------------------------------------------------------------ */
/* State machine (pure, unit tested)                                   */
/* ------------------------------------------------------------------ */

export type SignalingStatus =
  | "connecting" // socket not connected yet, or hello not acknowledged yet
  | "waiting" // in the queue
  | "match-found" // accept / pass prompt
  | "starting-call" // you accepted, waiting for the partner
  | "in-call"
  | "banned"
  | "replaced" // same device opened another tab
  | "error";

export interface ChatEntry {
  id: string;
  from: "me" | "partner" | "system";
  text: string;
  ts: number;
  /** Only for own messages: pending until the server acknowledges. */
  delivery?: "pending" | "sent" | "failed";
}

export interface SignalingState {
  status: SignalingStatus;
  /** The socket dropped after having been connected; a new hello will re-queue us. */
  reconnecting: boolean;
  roomId: string | null;
  partner: PublicProfile | null;
  isFriend: boolean;
  /** Null until call:start says which side creates the offer. */
  initiator: boolean | null;
  partnerAccepted: boolean;
  /** Accept deadline in the LOCAL clock (corrected for server clock skew). */
  expiresAt: number | null;
  coins: number | null;
  /** Increments on every positive coins:update so the UI can animate. */
  coinBump: number;
  iceServers: IceServer[];
  /** ICE servers (with per-call TURN credentials), bitrate caps and Hide my IP permission from call:start. */
  callMedia: CallMedia | null;
  /** Your effective mode for the current match (match:found). */
  matchMode: MatchMode | null;
  messages: ChatEntry[];
  partnerTyping: boolean;
  lastEndReason: MatchEndReason | null;
  error: string | null;
  /** Short-lived server notice such as rate limiting. */
  notice: ErrorCode | null;
}

export const initialSignalingState: SignalingState = {
  status: "connecting",
  reconnecting: false,
  roomId: null,
  partner: null,
  isFriend: false,
  initiator: null,
  partnerAccepted: false,
  expiresAt: null,
  coins: null,
  coinBump: 0,
  iceServers: [],
  callMedia: null,
  matchMode: null,
  messages: [],
  partnerTyping: false,
  lastEndReason: null,
  error: null,
  notice: null,
};

export type SignalingEvent =
  | { type: "socket-disconnected" }
  | { type: "connect-failed" }
  | { type: "hello-ok"; coins: number; iceServers: IceServer[] }
  | { type: "hello-failed"; error: ErrorCode | "timeout"; message?: string }
  | { type: "queue-waiting" }
  | {
      type: "match-found";
      roomId: string;
      partner: PublicProfile;
      isFriend: boolean;
      expiresAt: number;
      serverNow: number;
      receivedAt: number;
      mode?: MatchMode;
    }
  | { type: "local-accept" }
  | { type: "partner-accepted"; roomId: string }
  | { type: "call-start"; roomId: string; initiator: boolean; media?: CallMedia }
  | { type: "match-ended"; roomId: string; reason: MatchEndReason }
  | { type: "chat-received"; roomId: string; id: string; text: string; ts: number }
  | { type: "chat-local"; roomId: string; tempId: string; text: string; ts: number }
  | { type: "chat-ack"; tempId: string; ok: true; id: string; ts: number }
  | { type: "chat-ack"; tempId: string; ok: false }
  | { type: "partner-typing"; roomId: string; typing: boolean }
  | { type: "partner-typing-expired" }
  | { type: "coins"; balance: number; delta: number }
  | { type: "friends-new"; roomId: string }
  | { type: "session-replaced" }
  | { type: "server-error"; code: ErrorCode; message?: string }
  | { type: "notice-cleared" };

const TERMINAL: SignalingStatus[] = ["banned", "replaced"];

export const FRIENDS_MESSAGE = "🎉 You are now friends! You've been chatting for 5 minutes.";

/** Converts a server deadline into the local clock using the server time at emit. */
export function toLocalDeadline(expiresAt: number, serverNow: number, receivedAt: number): number {
  return receivedAt + (expiresAt - serverNow);
}

/** Whole seconds left until a local deadline, never negative. */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Fields that belong to one match / call and are reset when it ends. */
function clearRoom(state: SignalingState): SignalingState {
  return {
    ...state,
    roomId: null,
    partner: null,
    isFriend: false,
    initiator: null,
    partnerAccepted: false,
    expiresAt: null,
    callMedia: null,
    matchMode: null,
    messages: [],
    partnerTyping: false,
  };
}

export function signalingReducer(state: SignalingState, event: SignalingEvent): SignalingState {
  // A banned or replaced session stays put; only a remount starts over.
  if (TERMINAL.includes(state.status)) return state;

  switch (event.type) {
    case "socket-disconnected":
      // The WebRTC call is torn down with the room; the next hello re-queues us.
      return { ...clearRoom(state), status: "connecting", reconnecting: true };

    case "connect-failed":
      // socket.io keeps retrying on its own; tell the user why nothing happens.
      if (state.status !== "connecting") return state;
      return { ...state, error: "Cannot reach the server. Retrying..." };

    case "hello-ok": {
      const busy = state.status !== "connecting" && state.status !== "error";
      return {
        ...state,
        status: busy ? state.status : "waiting",
        reconnecting: false,
        error: null,
        coins: event.coins,
        iceServers: event.iceServers,
      };
    }

    case "hello-failed":
      if (event.error === "banned") return { ...clearRoom(state), status: "banned", reconnecting: false };
      return {
        ...clearRoom(state),
        status: "error",
        reconnecting: false,
        error: event.message ?? event.error,
      };

    case "queue-waiting":
      return { ...clearRoom(state), status: "waiting" };

    case "match-found":
      return {
        ...clearRoom(state),
        status: "match-found",
        roomId: event.roomId,
        partner: event.partner,
        isFriend: event.isFriend,
        expiresAt: toLocalDeadline(event.expiresAt, event.serverNow, event.receivedAt),
        matchMode: event.mode ?? null,
        lastEndReason: null,
      };

    case "local-accept":
      if (state.status !== "match-found") return state;
      return { ...state, status: "starting-call" };

    case "partner-accepted":
      if (event.roomId !== state.roomId) return state;
      return { ...state, partnerAccepted: true };

    case "call-start":
      if (event.roomId !== state.roomId) return state;
      if (state.status !== "match-found" && state.status !== "starting-call") return state;
      return {
        ...state,
        status: "in-call",
        initiator: event.initiator,
        partnerAccepted: true,
        expiresAt: null,
        callMedia: event.media ?? null,
      };

    case "match-ended":
      if (event.roomId !== state.roomId) return state;
      return { ...clearRoom(state), status: "waiting", lastEndReason: event.reason };

    case "chat-received":
      if (event.roomId !== state.roomId || state.status !== "in-call") return state;
      return {
        ...state,
        partnerTyping: false,
        messages: [...state.messages, { id: event.id, from: "partner", text: event.text, ts: event.ts }],
      };

    case "chat-local":
      if (event.roomId !== state.roomId || state.status !== "in-call") return state;
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: event.tempId, from: "me", text: event.text, ts: event.ts, delivery: "pending" },
        ],
      };

    case "chat-ack":
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== event.tempId) return m;
          return event.ok
            ? { ...m, id: event.id, ts: event.ts, delivery: "sent" }
            : { ...m, delivery: "failed" };
        }),
      };

    case "partner-typing":
      if (event.roomId !== state.roomId || state.status !== "in-call") return state;
      return { ...state, partnerTyping: event.typing };

    case "partner-typing-expired":
      return state.partnerTyping ? { ...state, partnerTyping: false } : state;

    case "coins":
      return {
        ...state,
        coins: event.balance,
        coinBump: event.delta > 0 ? state.coinBump + 1 : state.coinBump,
      };

    case "friends-new":
      if (event.roomId !== state.roomId || state.isFriend) return state;
      return {
        ...state,
        isFriend: true,
        messages: [
          ...state.messages,
          { id: `system-friends-${event.roomId}`, from: "system", text: FRIENDS_MESSAGE, ts: Date.now() },
        ],
      };

    case "session-replaced":
      return { ...clearRoom(state), status: "replaced", reconnecting: false };

    case "server-error":
      if (event.code === "banned") return { ...clearRoom(state), status: "banned", reconnecting: false };
      return { ...state, notice: event.code };

    case "notice-cleared":
      return state.notice ? { ...state, notice: null } : state;
  }
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

const ACK_TIMEOUT_MS = 8000;
const TYPING_IDLE_MS = 3000;
const TYPING_REFRESH_MS = 2000;
const PARTNER_TYPING_TTL_MS = 6000;
const NOTICE_TTL_MS = 4000;

export type SignalListener = (signal: RtcSignal) => void;

/** Per-call media settings from call:start. */
export interface CallMedia {
  iceServers: IceServer[];
  maxBitrateKbps: number;
  relayMaxBitrateKbps: number;
  privateModeAllowed: boolean;
}

/** Client events other hooks may send without touching this file. */
export type ExtraClientEvent = "call:failed" | "call:telemetry" | "moderation:signal";
type ExtraPayload<E extends ExtraClientEvent> = Parameters<ClientToServerEvents[E]>[0];

export type ServerEvent = keyof ServerToClientEvents;
type ServerHandler<E extends ServerEvent> = ServerToClientEvents[E];

export interface SignalingOptions {
  /** Requested match mode, read at every (re)connect. Defaults to "preview". */
  mode?: MatchMode;
}

export interface Signaling {
  state: SignalingState;
  accept: () => void;
  decline: () => void;
  skip: () => void;
  sendChat: (text: string) => Promise<ChatAck>;
  /** Call on every keystroke with whether the input has text. */
  setTyping: (typing: boolean) => void;
  /**
   * Reports a partner. Pass `roomId` to pin the report to the room the user saw (a post-call
   * report, or a call that ended while the report sheet was open); defaults to the current room.
   */
  report: (
    reason: ReportReason,
    details?: string,
    evidence?: ReportPayload["evidence"],
    roomId?: string,
  ) => Promise<ReportAck>;
  updatePreferences: (preferences: Preferences) => Promise<SimpleAck>;
  sendSignal: (signal: RtcSignal) => void;
  /** Tell the server this call's peer connection is up (once per room); coins count from then. */
  reportConnected: () => void;
  /** Subscribe to rtc:signal for a room. Signals that arrived before subscribing are replayed. */
  subscribeSignals: (roomId: string, listener: SignalListener) => () => void;
  /** Drop the socket and connect again (after an error). */
  retry: () => void;
  /**
   * Listen to any server event (also across reconnects) without editing this hook.
   * Returns an unsubscribe function. Handlers run after this hook's own reducer handling.
   */
  subscribe: <E extends ServerEvent>(event: E, handler: ServerHandler<E>) => () => void;
  /** Send telemetry, call-failed and moderation signals for the current connection. */
  send: <E extends ExtraClientEvent>(event: E, payload: ExtraPayload<E>) => void;
}

function notConnected<T extends object>(): Promise<Ack<T>> {
  return Promise.resolve({ ok: false, error: "internal", message: "Not connected to the server" });
}

const MAX_PENDING_SIGNALS = 200;

export function useSignaling(profile: Profile, preferences: Preferences, options: SignalingOptions = {}): Signaling {
  const [state, dispatch] = useReducer(signalingReducer, initialSignalingState);
  const modeRef = useRef<MatchMode>(options.mode ?? "preview");
  modeRef.current = options.mode ?? "preview";
  // Listeners registered through subscribe(), dispatched from socket.onAny so they survive reconnects.
  const extraListeners = useRef(new Map<string, Set<(...args: unknown[]) => void>>());

  const socketRef = useRef<AppSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // The hello payload is read at connect time, so reconnects send the latest values.
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const preferencesRef = useRef(preferences);

  const signalListeners = useRef(new Map<string, SignalListener>());
  const pendingSignals = useRef<RtcSignal[]>([]);

  const typingSent = useRef<{ typing: boolean; at: number; roomId: string | null }>({
    typing: false,
    at: 0,
    roomId: null,
  });
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const socket: AppSocket = io(API_URL, {
      transports: ["websocket"],
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      // Read at every (re)connect, so a refreshed session token is picked up.
      auth: (cb) => cb({ sessionToken: getSessionToken() ?? "" }),
    });
    socketRef.current = socket;
    socket.onAny((event: string, ...args: unknown[]) => {
      extraListeners.current.get(event)?.forEach((handler) => handler(...args));
    });
    let connectionSeq = 0;
    // Set on unmount, ban or replacement: never reconnect after that.
    let stopped = false;
    const stop = () => {
      stopped = true;
      socket.disconnect();
    };

    socket.on("connect", () => {
      const seq = ++connectionSeq;
      const payload = {
        protocolVersion: PROTOCOL_VERSION,
        deviceId: getDeviceId(),
        profile: profileRef.current,
        preferences: preferencesRef.current,
        mode: modeRef.current,
      } as const;
      const valid = helloSchema.safeParse(payload);
      if (!valid.success) {
        const field = valid.error.issues[0]?.path.join(".") || "profile";
        dispatch({ type: "hello-failed", error: "invalid_payload", message: `Invalid ${field}` });
        return;
      }
      socket.timeout(ACK_TIMEOUT_MS).emit("session:hello", valid.data, (err: Error | null, res: HelloAck) => {
        if (seq !== connectionSeq || stopped) return; // ack of an older connection
        if (err) {
          dispatch({ type: "hello-failed", error: "timeout", message: "The server did not answer" });
        } else if (res.ok === true) {
          dispatch({ type: "hello-ok", coins: res.coins, iceServers: res.iceServers });
        } else {
          dispatch({ type: "hello-failed", error: res.error, message: res.message });
          if (res.error === "banned") stop();
        }
      });
    });

    socket.on("disconnect", (reason) => {
      pendingSignals.current = [];
      if (stopped) return;
      dispatch({ type: "socket-disconnected" });
      // A server-initiated disconnect (deploy, shutdown) is not retried by socket.io itself.
      if (reason === "io server disconnect") socket.connect();
    });

    socket.on("connect_error", (err: Error & { data?: { code?: string } }) => {
      if (stopped) return;
      dispatch({ type: "connect-failed" });
      // The handshake refused the session: socket.io does not retry that by itself.
      // The gate asks for a new session; connect again once it is saved.
      const code = err.data?.code;
      if (code === "session_required" || code === "region_blocked") {
        invalidateSession(code);
        void waitForSession().then(() => {
          if (!stopped) socket.connect();
        });
      }
    });

    socket.on("queue:waiting", () => dispatch({ type: "queue-waiting" }));
    socket.on("match:found", (p) => {
      pendingSignals.current = [];
      dispatch({ type: "match-found", ...p, receivedAt: Date.now() });
      // Instant mode: the server accepts for us. Accepting here too is a no-op on
      // such a server and covers one without server-side auto-accept.
      if (p.mode === "instant") {
        socket.emit("match:accept", { roomId: p.roomId });
        dispatch({ type: "local-accept" });
      }
    });
    socket.on("match:partner-accepted", (p) => dispatch({ type: "partner-accepted", roomId: p.roomId }));
    socket.on("match:ended", (p) => {
      pendingSignals.current = [];
      dispatch({ type: "match-ended", roomId: p.roomId, reason: p.reason });
    });
    socket.on("call:start", (p) =>
      dispatch({
        type: "call-start",
        roomId: p.roomId,
        initiator: p.initiator,
        media: {
          iceServers: p.iceServers,
          maxBitrateKbps: p.maxBitrateKbps,
          relayMaxBitrateKbps: p.relayMaxBitrateKbps,
          privateModeAllowed: p.privateModeAllowed,
        },
      }),
    );
    socket.on("rtc:signal", (signal) => {
      const listener = signalListeners.current.get(signal.roomId);
      if (listener) listener(signal);
      else if (pendingSignals.current.length < MAX_PENDING_SIGNALS) pendingSignals.current.push(signal);
    });
    socket.on("chat:message", (p) => dispatch({ type: "chat-received", ...p }));
    socket.on("chat:typing", (p) => dispatch({ type: "partner-typing", roomId: p.roomId, typing: p.typing }));
    socket.on("coins:update", (p) => dispatch({ type: "coins", balance: p.balance, delta: p.delta }));
    socket.on("friends:new", (p) => dispatch({ type: "friends-new", roomId: p.roomId }));
    socket.on("session:replaced", () => {
      dispatch({ type: "session-replaced" });
      stop();
    });
    socket.on("server:error", (p) => {
      dispatch({ type: "server-error", code: p.code, message: p.message });
      if (p.code === "banned") stop();
    });
    socket.on("server:shutdown", () => {
      // The server closes the socket next; the disconnect handler reconnects.
    });

    socket.connect();

    return () => {
      stopped = true;
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    };
  }, []);

  // Clear the partner typing indicator if the "stopped typing" event never arrives.
  useEffect(() => {
    if (!state.partnerTyping) return;
    const t = setTimeout(() => dispatch({ type: "partner-typing-expired" }), PARTNER_TYPING_TTL_MS);
    return () => clearTimeout(t);
  }, [state.partnerTyping, state.messages.length]);

  useEffect(() => {
    if (!state.notice) return;
    const t = setTimeout(() => dispatch({ type: "notice-cleared" }), NOTICE_TTL_MS);
    return () => clearTimeout(t);
  }, [state.notice]);

  // Stop announcing typing when the room changes.
  useEffect(() => {
    if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    typingSent.current = { typing: false, at: 0, roomId: null };
  }, [state.roomId]);

  const connectedSocket = (): AppSocket | null => {
    const socket = socketRef.current;
    return socket && socket.connected ? socket : null;
  };

  const accept = useCallback(() => {
    const { roomId, status, expiresAt } = stateRef.current;
    const socket = connectedSocket();
    if (!socket || !roomId || status !== "match-found") return;
    // The countdown hit 0: the server ends this match, so do not show a spinner for it.
    if (expiresAt !== null && Date.now() >= expiresAt) return;
    socket.emit("match:accept", { roomId });
    dispatch({ type: "local-accept" });
  }, []);

  const decline = useCallback(() => {
    const { roomId, status } = stateRef.current;
    const socket = connectedSocket();
    if (!socket || !roomId || (status !== "match-found" && status !== "starting-call")) return;
    socket.emit("match:decline", { roomId });
  }, []);

  // call:skip carries no roomId and the server skips whatever room we are in now,
  // so a second click (or the auto-skip timer) would skip the next, unseen match.
  // A pending match can be skipped too (Next while an instant call connects, Esc on the card).
  const skippedRoom = useRef<string | null>(null);
  const skip = useCallback(() => {
    const socket = connectedSocket();
    const { roomId, status } = stateRef.current;
    const inRoom = status === "in-call" || status === "match-found" || status === "starting-call";
    if (!socket || !roomId || !inRoom || skippedRoom.current === roomId) return;
    skippedRoom.current = roomId;
    socket.emit("call:skip");
  }, []);

  const emitTyping = useCallback((typing: boolean) => {
    const socket = connectedSocket();
    const { roomId, status } = stateRef.current;
    if (!socket || !roomId || status !== "in-call") return;
    socket.emit("chat:typing", { roomId, typing });
    typingSent.current = { typing, at: Date.now(), roomId };
  }, []);

  const setTyping = useCallback(
    (typing: boolean) => {
      if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
      const sent = typingSent.current;
      if (!typing) {
        if (sent.typing) emitTyping(false);
        return;
      }
      // Throttle: announce once, refresh at most every TYPING_REFRESH_MS.
      if (!sent.typing || Date.now() - sent.at >= TYPING_REFRESH_MS) emitTyping(true);
      typingIdleTimer.current = setTimeout(() => {
        if (typingSent.current.typing) emitTyping(false);
      }, TYPING_IDLE_MS);
    },
    [emitTyping],
  );

  const sendChat = useCallback(
    async (raw: string): Promise<ChatAck> => {
      const text = raw.trim().slice(0, LIMITS.chatMax);
      const { roomId, status } = stateRef.current;
      const socket = connectedSocket();
      if (!text) return { ok: false, error: "invalid_payload", message: "Empty message" };
      if (!socket || !roomId || status !== "in-call") return notConnected();
      setTyping(false);
      const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      dispatch({ type: "chat-local", roomId, tempId, text, ts: Date.now() });
      let res: ChatAck;
      try {
        res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("chat:send", { roomId, text });
      } catch {
        res = { ok: false, error: "internal", message: "The server did not answer" };
      }
      dispatch(res.ok ? { type: "chat-ack", tempId, ok: true, id: res.id, ts: res.ts } : { type: "chat-ack", tempId, ok: false });
      return res;
    },
    [setTyping],
  );

  const report = useCallback(async (
    reason: ReportReason,
    details?: string,
    evidence?: ReportPayload["evidence"],
    targetRoomId?: string,
  ): Promise<ReportAck> => {
    const roomId = targetRoomId ?? stateRef.current.roomId;
    const socket = connectedSocket();
    if (!socket || !roomId) return notConnected();
    const trimmed = details?.trim().slice(0, LIMITS.reportDetailsMax);
    try {
      return await socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck("report:submit", {
          roomId,
          reason,
          ...(trimmed ? { details: trimmed } : {}),
          ...(evidence ? { evidence } : {}),
        });
    } catch {
      return { ok: false, error: "internal", message: "The server did not answer" };
    }
  }, []);

  const updatePreferences = useCallback(async (next: Preferences): Promise<SimpleAck> => {
    const socket = connectedSocket();
    if (!socket) return notConnected();
    try {
      const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("session:preferences", { preferences: next });
      if (res.ok) preferencesRef.current = next;
      return res;
    } catch {
      return { ok: false, error: "internal", message: "The server did not answer" };
    }
  }, []);

  const sendSignal = useCallback((signal: RtcSignal) => {
    connectedSocket()?.emit("rtc:signal", signal);
  }, []);

  const reportedConnected = useRef<string | null>(null);
  const reportConnected = useCallback(() => {
    const socket = connectedSocket();
    const { roomId, status } = stateRef.current;
    if (!socket || !roomId || status !== "in-call" || reportedConnected.current === roomId) return;
    reportedConnected.current = roomId;
    socket.emit("call:connected", { roomId });
  }, []);

  const subscribeSignals = useCallback((roomId: string, listener: SignalListener) => {
    signalListeners.current.set(roomId, listener);
    const replay = pendingSignals.current.filter((s) => s.roomId === roomId);
    pendingSignals.current = pendingSignals.current.filter((s) => s.roomId !== roomId);
    replay.forEach((signal) => listener(signal));
    return () => {
      if (signalListeners.current.get(roomId) === listener) signalListeners.current.delete(roomId);
    };
  }, []);

  const subscribe = useCallback(<E extends ServerEvent>(event: E, handler: ServerHandler<E>) => {
    const set = extraListeners.current.get(event) ?? new Set();
    const fn = handler as unknown as (...args: unknown[]) => void;
    set.add(fn);
    extraListeners.current.set(event, set);
    return () => {
      set.delete(fn);
    };
  }, []);

  const send = useCallback(<E extends ExtraClientEvent>(event: E, payload: ExtraPayload<E>) => {
    const socket = connectedSocket();
    if (!socket) return;
    (socket.emit as (e: string, p: unknown) => void)(event, payload);
  }, []);

  const retry = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || TERMINAL.includes(stateRef.current.status)) return;
    socket.disconnect();
    socket.connect();
  }, []);

  return {
    state,
    accept,
    decline,
    skip,
    sendChat,
    setTyping,
    report,
    updatePreferences,
    sendSignal,
    reportConnected,
    subscribeSignals,
    retry,
    subscribe,
    send,
  };
}
