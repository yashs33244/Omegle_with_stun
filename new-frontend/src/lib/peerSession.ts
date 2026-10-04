import { rtcConfiguration } from "./connectivity";
import type { IceServer, RtcSignal } from "./protocol";

export type ConnectionQuality = "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "DISCONNECTED";

export interface PeerSessionOptions {
  roomId: string;
  initiator: boolean;
  iceServers: IceServer[];
  /** "Hide my IP": relay-only ICE (iceTransportPolicy "relay"). */
  privateMode?: boolean;
  localStream: MediaStream | null;
  sendSignal: (signal: RtcSignal) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
  /** Injection point for tests. */
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  /** Injection point for tests (jsdom has no MediaStream). */
  createMediaStream?: () => MediaStream;
}

/**
 * One RTCPeerConnection for one call. The initiator sends the offer, the other
 * side answers. Remote ICE candidates that arrive before the remote description
 * is applied are queued and flushed afterwards. Incoming signals are processed
 * strictly in order.
 */
export class PeerSession {
  readonly pc: RTCPeerConnection;
  private readonly opts: PeerSessionOptions;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  private chain: Promise<void> = Promise.resolve();
  private remoteStream: MediaStream | null = null;
  private closed = false;
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private paused = false;
  private placeholder: MediaStreamTrack | null = null;
  private iceRestarted = false;

  constructor(opts: PeerSessionOptions) {
    this.opts = opts;
    const create = opts.createPeerConnection ?? ((config) => new RTCPeerConnection(config));
    this.pc = create(rtcConfiguration(opts.iceServers, opts.privateMode ?? false));

    this.pc.onicecandidate = (e) => {
      if (!e.candidate || this.closed) return;
      const c = e.candidate.toJSON();
      this.opts.sendSignal({
        roomId: opts.roomId,
        candidate: {
          candidate: c.candidate ?? "",
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
          usernameFragment: c.usernameFragment ?? null,
        },
      });
    };

    this.pc.ontrack = (e) => {
      if (this.closed) return;
      const [stream] = e.streams;
      if (stream) {
        this.remoteStream = stream;
      } else {
        this.remoteStream ??= (opts.createMediaStream ?? (() => new MediaStream()))();
        if (!this.remoteStream.getTracks().includes(e.track)) this.remoteStream.addTrack(e.track);
      }
      this.opts.onRemoteStream(this.remoteStream);
    };

    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const state = this.pc.connectionState;
      // One ICE restart per call: the initiator re-offers with fresh credentials.
      if (state === "failed" && this.opts.initiator && !this.iceRestarted) {
        this.iceRestarted = true;
        void this.restartIce();
      }
      this.opts.onConnectionStateChange(state);
    };

    const stream = opts.localStream;
    stream?.getTracks().forEach((track) => {
      const sender = this.pc.addTrack(track, stream) as RTCRtpSender | undefined;
      if (track.kind === "video") {
        this.videoSender = sender ?? null;
        this.cameraTrack = track;
      } else if (track.kind === "audio") {
        this.audioSender = sender ?? null;
      }
    });
    // Still ask for the partner's media of any kind we have none to send
    // (no stream at all, or a camera-only stream when there is no microphone).
    if (!stream || stream.getAudioTracks().length === 0) {
      this.pc.addTransceiver("audio", { direction: "recvonly" });
    }
    if (!stream || stream.getVideoTracks().length === 0) {
      this.pc.addTransceiver("video", { direction: "recvonly" });
    }
  }

  /** Initiator only: create and send the offer. */
  start(): Promise<void> {
    if (!this.opts.initiator) return Promise.resolve();
    return this.enqueue(async () => {
      const offer = await this.pc.createOffer();
      if (this.closed) return;
      await this.pc.setLocalDescription(offer);
      this.sendDescription(offer);
    });
  }

  handleSignal(signal: RtcSignal): Promise<void> {
    if (signal.roomId !== this.opts.roomId) return Promise.resolve();
    return this.enqueue(async () => {
      if (signal.description) await this.handleDescription(signal.description);
      else if (signal.candidate) await this.handleCandidate(signal.candidate);
    });
  }

  /**
   * ICE restart. Only the initiator sends offers, so only it restarts; the
   * other side answers the restart offer with fresh credentials on its own.
   * Runs once by itself when the connection fails, and when the connect
   * monitor asks (4 s disconnected, or failed). A request while an offer is
   * already out is a no-op, so the two never send two restart offers.
   */
  restartIce(): Promise<void> {
    if (!this.opts.initiator) return Promise.resolve();
    return this.enqueue(async () => {
      if (this.pc.signalingState !== "stable") return;
      const offer = await this.pc.createOffer({ iceRestart: true });
      if (this.closed) return;
      await this.pc.setLocalDescription(offer);
      this.sendDescription(offer);
    });
  }

  /** The sender of our camera, for bitrate limits. */
  get video(): RTCRtpSender | null {
    return this.videoSender;
  }

  /**
   * The face gate's pause: send the placeholder (or nothing) instead of the
   * camera while paused, the camera again afterwards.
   */
  setVideoPaused(paused: boolean, placeholder: MediaStreamTrack | null): void {
    this.paused = paused;
    this.placeholder = placeholder;
    this.syncVideo();
  }

  /**
   * The local camera or microphone was replaced (camera flip, iOS recovery
   * after backgrounding): swap the tracks without renegotiating.
   */
  setLocalStream(stream: MediaStream | null): void {
    if (!stream || this.closed) return;
    const audio = stream.getAudioTracks()[0];
    if (audio && this.audioSender && this.audioSender.track !== audio) {
      this.audioSender.replaceTrack(audio).catch((err) => console.warn("Could not replace the audio track", err));
    }
    const video = stream.getVideoTracks()[0];
    if (video) this.cameraTrack = video;
    this.syncVideo();
  }

  private syncVideo(): void {
    if (this.closed || !this.videoSender) return;
    const wanted = this.paused ? this.placeholder : this.cameraTrack;
    if (this.videoSender.track === wanted) return;
    this.videoSender.replaceTrack(wanted).catch((err) => console.warn("Could not replace the video track", err));
  }

  /** Candidates waiting for the remote description (exposed for tests). */
  get queuedCandidateCount(): number {
    return this.pendingCandidates.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingCandidates = [];
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = async () => {
      if (this.closed) return;
      try {
        await task();
      } catch (err) {
        if (!this.closed) console.warn("WebRTC signaling step failed", err);
      }
    };
    this.chain = this.chain.then(run);
    return this.chain;
  }

  private async handleDescription(signal: NonNullable<RtcSignal["description"]>): Promise<void> {
    const desc: RTCSessionDescriptionInit = { type: signal.type, sdp: signal.sdp };
    if (desc.type === "offer") {
      // Only the non-initiator answers; an offer to the initiator would be glare.
      if (this.opts.initiator || this.pc.signalingState !== "stable") return;
      await this.pc.setRemoteDescription(desc);
      await this.onRemoteDescriptionSet();
      const answer = await this.pc.createAnswer();
      if (this.closed) return;
      await this.pc.setLocalDescription(answer);
      this.sendDescription(answer);
    } else {
      if (this.pc.signalingState !== "have-local-offer") return;
      await this.pc.setRemoteDescription(desc);
      await this.onRemoteDescriptionSet();
    }
  }

  private async handleCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.addCandidate(candidate);
  }

  private async onRemoteDescriptionSet(): Promise<void> {
    this.hasRemoteDescription = true;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of queued) await this.addCandidate(c);
  }

  private async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // One bad candidate must not stop the others.
      if (!this.closed) console.warn("Ignoring ICE candidate", err);
    }
  }

  private sendDescription(desc: RTCSessionDescriptionInit): void {
    if (this.closed || !desc.sdp || (desc.type !== "offer" && desc.type !== "answer")) return;
    this.opts.sendSignal({ roomId: this.opts.roomId, description: { type: desc.type, sdp: desc.sdp } });
  }
}

/* ------------------------------------------------------------------ */
/* Connection quality                                                  */
/* ------------------------------------------------------------------ */

export interface StatsSample {
  /** Round trip time of the selected candidate pair, in seconds. */
  rtt: number | null;
  packetsReceived: number;
  packetsLost: number;
}

/** Pulls RTT and inbound packet counters out of an RTCStatsReport. */
export function readStats(report: RTCStatsReport): StatsSample {
  let rtt: number | null = null;
  let packetsReceived = 0;
  let packetsLost = 0;
  report.forEach((s) => {
    if (s.type === "candidate-pair" && (s.nominated || s.selected) && s.state === "succeeded") {
      if (typeof s.currentRoundTripTime === "number") rtt = s.currentRoundTripTime;
    } else if (s.type === "inbound-rtp") {
      packetsReceived += s.packetsReceived ?? 0;
      packetsLost += s.packetsLost ?? 0;
    }
  });
  return { rtt, packetsReceived, packetsLost };
}

/** Maps RTT and the packet loss since the previous sample to a level. */
export function qualityFromStats(current: StatsSample, previous: StatsSample | null): ConnectionQuality {
  const received = current.packetsReceived - (previous?.packetsReceived ?? 0);
  const lost = Math.max(0, current.packetsLost - (previous?.packetsLost ?? 0));
  const loss = received + lost > 0 ? lost / (received + lost) : 0;
  const rttMs = current.rtt === null ? 0 : current.rtt * 1000;

  if (loss > 0.1 || rttMs > 600) return "POOR";
  if (loss > 0.05 || rttMs > 300) return "FAIR";
  if (loss > 0.01 || rttMs > 150) return "GOOD";
  return "EXCELLENT";
}
