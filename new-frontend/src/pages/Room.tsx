import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader, Lock, MessageCircle, Video, VideoOff, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChatSettings } from "@/components/ChatSettings";
import { CallActionBar } from "@/components/room/CallActionBar";
import { ChatPanel, PartnerTyping } from "@/components/room/ChatPanel";
import { ChatSheet, ChatToast } from "@/components/room/ChatSheet";
import { HideIpToggle } from "@/components/room/HideIpToggle";
import { MatchPrompt } from "@/components/room/MatchPrompt";
import { RoomHeader } from "@/components/room/RoomHeader";
import { ShortcutHint } from "@/components/room/ShortcutHint";
import { VideoTile } from "@/components/room/VideoTile";
import { WaitingPanel } from "@/components/room/WaitingPanel";
import { NudgeToast } from "@/components/safety/NudgeToast";
import { PostCallReport } from "@/components/safety/PostCallReport";
import { ReportSheet } from "@/components/safety/ReportSheet";
import { SafetyCoachGate } from "@/components/safety/SafetyCoachCard";
import { NUDGE_KEYS } from "@/components/safety/safetyText";
import { useCallSafety } from "@/components/safety/useCallSafety";
import { Watermark } from "@/components/safety/Watermark";
import { useAudioLevelDetection } from "@/hooks/useAudioLevelDetection";
import { DESKTOP_QUERY, LANDSCAPE_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { useNextShortcut } from "@/hooks/useNextShortcut";
import { usePeerConnection } from "@/hooks/usePeerConnection";
import { usePipDrag } from "@/hooks/usePipDrag";
import { useSignaling, type ChatEntry } from "@/hooks/useSignaling";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useRoomGate } from "@/pages/gate/useRoomGate";
import { useGenderFilterGate, useWalletSync } from "@/premium";
import type { ErrorCode, MatchMode, ModerationSignalPayload, Preferences, Profile, PublicProfile, SimpleAck } from "@/lib/protocol";
import { RemoteBlurOverlay } from "@/moderation/RemoteBlurOverlay";
import { isBlurred } from "@/moderation/blurGate";
import { useFaceGate } from "@/moderation/useFaceGate";
import { useRemoteBlur } from "@/moderation/useRemoteBlur";
import { activeCameraLabel, isVirtualCameraLabel } from "@/moderation/virtualCamera";
import { CaptionsOverlay, useCaptions } from "@/captions";
import { SparkCard, useSpark } from "@/spark";

export interface RoomProps {
  profile: Profile;
  preferences: Preferences;
  /** Called after the server accepted new preferences, so Landing can keep them. */
  onPreferencesChange?: (preferences: Preferences) => void;
  localStream: MediaStream | null;
  micEnabled: boolean;
  onMicEnabledChange: (enabled: boolean) => void;
  /** Text-only mode turns the camera track off so the partner stops seeing you. */
  onCameraEnabledChange: (enabled: boolean) => void;
  onBackToHome: () => void;
  /** Instant (the call starts right away, blurred) or Preview (accept card). */
  mode?: MatchMode;
  /** The user's Hide my IP choice; used when a call starts and the server allows it. */
  hideIp?: boolean;
  onHideIpChange?: (hideIp: boolean) => void;
  /** Phones: switch between the front and back camera. */
  onFlipCamera?: () => void;
  /** False while the back camera is in use: the preview is then not mirrored. */
  frontCamera?: boolean;
}

type ModerationKind = ModerationSignalPayload["kind"];

/** Instant mode while the server connects you: no accept card, just a moment. */
const ConnectingPanel: React.FC<{ partner: PublicProfile }> = ({ partner }) => {
  const { t } = useTranslation("room");
  return (
    <div className="absolute inset-0 z-[12] flex items-center justify-center bg-black/70 p-4" data-testid="instant-connecting">
      <div className="space-y-3 text-center text-white">
        <Loader className="mx-auto h-10 w-10 animate-spin text-yellow-400" aria-hidden="true" />
        <p className="text-lg font-medium">{t("connecting.withPartner", { name: partner.name })}</p>
      </div>
    </div>
  );
};

/**
 * A call whose connection stays failed this long is skipped automatically
 * (the initiator has already tried one ICE restart by then). The answering
 * side waits longer, so normally only one side skips and the other is told.
 */
const FAILED_SKIP_MS = 10_000;
const FAILED_SKIP_STAGGER_MS = 4_000;

/** The local picture-in-picture starts under the top bar (which pads for the notch itself). */
const PIP_START_TOP_PX = 72;
/** Landscape phones: the action rail (icons in two 56 px columns, then Stop/Next/Chat) sits on the right edge. */
const PIP_START_RIGHT_RAIL_PX = 228;

type NoticeKey = `notice.${"rateLimited" | "notInRoom" | "invalidPayload" | "internal"}`;

const NOTICE_KEYS: Partial<Record<ErrorCode, NoticeKey>> = {
  rate_limited: "notice.rateLimited",
  not_in_room: "notice.notInRoom",
  invalid_payload: "notice.invalidPayload",
  internal: "notice.internal",
};

/** A short translucent line in the status strip under the top bar. */
const StatusChip: React.FC<{ children: React.ReactNode; tone?: "info" | "warn" | "ok"; testId?: string; role?: string }> = ({
  children,
  tone = "info",
  testId,
  role = "status",
}) => (
  <span
    role={role}
    data-testid={testId}
    className={`flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs backdrop-blur-sm ${
      tone === "warn" ? "text-orange-300" : tone === "ok" ? "text-green-400" : "text-white"
    }`}
  >
    {children}
  </span>
);

const TextOnlyPanel: React.FC<{
  partner: PublicProfile | null;
  partnerTyping: boolean;
  micEnabled: boolean;
  onSwitchToVideo: () => void;
}> = ({ partner, partnerTyping, micEnabled, onSwitchToVideo }) => {
  const { t } = useTranslation("room");
  return (
    // Portrait phones: the chat sheet starts TEXT_ONLY_SHEET_TOP below the top; this panel keeps to the band above it.
    <div className="absolute inset-0 z-[5] flex flex-col items-center space-y-2 bg-gray-900 px-6 pt-[calc(env(safe-area-inset-top)+4.5rem)] text-center max-lg:landscape:justify-center max-lg:landscape:pl-[52vw] max-lg:landscape:pr-[14.5rem] lg:justify-center lg:space-y-3">
      <MessageCircle className="hidden h-12 w-12 text-yellow-400 max-lg:landscape:block lg:block lg:h-16 lg:w-16" aria-hidden="true" />
      <div className="space-y-1 text-white">
        <h3 className="text-xl font-bold">{t("textOnly.title")}</h3>
        <p className="text-gray-300">{t("textOnly.chattingWith", { name: partner?.name || t("textOnly.stranger") })}</p>
        <p className="text-sm text-gray-400">{micEnabled ? t("textOnly.cameraOff") : t("textOnly.cameraAndMicOff")}</p>
        {partnerTyping && <PartnerTyping />}
      </div>
      <button
        type="button"
        onClick={onSwitchToVideo}
        className="flex min-h-[2.75rem] items-center gap-2 rounded-full border-2 border-black bg-yellow-400 px-5 font-bold text-black shadow-[0_3px_0_#000] hover:bg-yellow-300"
      >
        <Video className="h-5 w-5" aria-hidden="true" />
        {t("textOnly.switchToVideo")}
      </button>
    </div>
  );
};

/** The first visit shows the safety card before anything connects or queues. */
export const Room: React.FC<RoomProps> = (props) => (
  <SafetyCoachGate onBack={props.onBackToHome}>
    <RoomSession {...props} />
  </SafetyCoachGate>
);

const RoomSession: React.FC<RoomProps> = ({
  profile,
  preferences: initialPreferences,
  onPreferencesChange,
  localStream,
  micEnabled,
  onMicEnabledChange,
  onCameraEnabledChange,
  onBackToHome,
  mode = "preview",
  hideIp = false,
  onHideIpChange,
  onFlipCamera,
  frontCamera = true,
}) => {
  const { t } = useTranslation(["room", "safety", "premium"]);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const landscape = useMediaQuery(LANDSCAPE_QUERY);
  const [preferences, setPreferences] = useState<Preferences>(initialPreferences);
  const signaling = useSignaling(profile, initialPreferences, { mode });
  useWalletSync(signaling);
  const { state, updatePreferences, send } = signaling;
  const stageRef = useRef<HTMLDivElement>(null);
  const safety = useCallSafety(signaling, () =>
    stageRef.current?.querySelector<HTMLVideoElement>('video[data-testid="remote-video"]') ?? null,
  );

  const inCall = state.status === "in-call";
  const matchPhase = state.status === "match-found" || state.status === "starting-call";
  const callRoomId = inCall ? state.roomId : null;
  const spark = useSpark({ signaling, roomId: callRoomId });
  const captions = useCaptions({
    signaling,
    roomId: callRoomId,
    localStream,
    micEnabled,
    partnerLanguage: state.partner?.language ?? null,
    viewerLanguage: profile.language,
  });

  const [showChat, setShowChat] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [textOnlyMode, setTextOnlyMode] = useState(false);
  /** Entering text-only muted the mic, and the user has not touched it since. */
  const textOnlyMutedMicRef = useRef(false);

  // Text-only mutes the mic too; the mic button in the action bar keeps working.
  const enterTextOnly = () => {
    textOnlyMutedMicRef.current = micEnabled;
    if (micEnabled) onMicEnabledChange(false);
    setTextOnlyMode(true);
  };
  // Back to video: unmute only if text-only is what muted the mic.
  const leaveTextOnly = useCallback(() => {
    if (textOnlyMutedMicRef.current) onMicEnabledChange(true);
    textOnlyMutedMicRef.current = false;
    setTextOnlyMode(false);
  }, [onMicEnabledChange]);
  const toggleMic = () => {
    textOnlyMutedMicRef.current = false;
    onMicEnabledChange(!micEnabled);
  };

  const sendModeration = useCallback(
    (roomId: string, kind: ModerationKind) => send("moderation:signal", { roomId, kind }),
    [send],
  );

  // Sender face gate: no face for 3 s pauses our outgoing video.
  const faceGate = useFaceGate({
    stream: localStream,
    enabled: !textOnlyMode,
    roomId: callRoomId,
    onNoFace: (roomId) => sendModeration(roomId, "no-face"),
  });

  const peer = usePeerConnection({
    roomId: callRoomId,
    initiator: inCall ? state.initiator : null,
    iceServers: state.iceServers,
    media: state.callMedia,
    hideIp,
    localStream,
    videoPaused: faceGate.paused,
    videoPlaceholder: faceGate.placeholder,
    sendSignal: signaling.sendSignal,
    subscribeSignals: signaling.subscribeSignals,
    onCallFailed: (roomId, reason) => send("call:failed", { roomId, reason }),
    onTelemetry: (payload) => send("call:telemetry", payload),
  });

  const roomGate = useRoomGate(signaling, { onLeave: onBackToHome, connected: peer.connectionState === "connected" });

  // Receiver safe-start blur on the partner's video.
  const [remoteVideo, setRemoteVideo] = useState<HTMLVideoElement | null>(null);
  const blur = useRemoteBlur({ roomId: callRoomId, video: remoteVideo, onSignal: sendModeration });
  const remoteBlurred = isBlurred(blur.status);

  // Virtual cameras (OBS and the like) are counted once per session.
  const virtualCameraSent = useRef(false);
  useEffect(() => {
    if (!callRoomId || virtualCameraSent.current) return;
    let cancelled = false;
    void activeCameraLabel(localStream?.getVideoTracks()[0]).then((label) => {
      if (cancelled || virtualCameraSent.current || !isVirtualCameraLabel(label)) return;
      virtualCameraSent.current = true;
      sendModeration(callRoomId, "virtual-camera");
    });
    return () => {
      cancelled = true;
    };
  }, [callRoomId, localStream, sendModeration]);

  useWakeLock(inCall);
  const canSkip = inCall || matchPhase;
  useNextShortcut(canSkip, signaling.skip);
  const instantConnecting = matchPhase && state.matchMode === "instant";
  // In a call your own video shrinks to a draggable picture-in-picture; otherwise it is the backdrop.
  const pipActive = inCall && !textOnlyMode;
  const pip = usePipDrag(pipActive, { start: { top: PIP_START_TOP_PX, right: landscape && !desktop ? PIP_START_RIGHT_RAIL_PX : 12 } });

  // Text-only is per call: a new call starts with video again.
  useEffect(() => {
    leaveTextOnly();
    setShowChat(false);
  }, [state.roomId, leaveTextOnly]);

  // The partner must stop seeing us in text-only mode.
  useEffect(() => {
    onCameraEnabledChange(!textOnlyMode);
  }, [textOnlyMode, onCameraEnabledChange]);

  // Leave the camera and mic usable for the next screen.
  useEffect(
    () => () => {
      onCameraEnabledChange(true);
      onMicEnabledChange(true);
    },
    [onCameraEnabledChange, onMicEnabledChange],
  );

  const localAudioTrack = localStream?.getAudioTracks()[0] ?? null;
  const { isSpeaking: localIsSpeaking } = useAudioLevelDetection(micEnabled ? localAudioTrack : null);
  const { isSpeaking: remoteIsSpeaking } = useAudioLevelDetection(inCall ? peer.remoteAudioTrack : null);

  const handleUpdatePreferences = useCallback(
    async (next: Preferences): Promise<SimpleAck> => {
      const res = await updatePreferences(next);
      if (res.ok === true) {
        setPreferences(next);
        onPreferencesChange?.(next);
      }
      return res;
    },
    [updatePreferences, onPreferencesChange],
  );

  // The server queues us with the filter off when its unlock is missing or
  // lapsed (hello ack, or premium_required mid-session): keep the local
  // preferences honest and say so, with a way to the unlock sheet.
  const [filterOff, setFilterOff] = useState(false);
  const genderGate = useGenderFilterGate();
  const serverGenderFilter = state.genderFilter;
  useEffect(() => {
    if (serverGenderFilter === null || serverGenderFilter === preferences.genderFilter) return;
    const next = { ...preferences, genderFilter: serverGenderFilter };
    setPreferences(next);
    onPreferencesChange?.(next);
    setFilterOff(serverGenderFilter === "all");
  }, [serverGenderFilter, preferences, onPreferencesChange]);

  const handleSend = (text: string) => {
    void signaling.sendChat(text).then(safety.noteChatAck);
  };

  // The chat is open as a side column (desktop) or sheet (phones); text-only keeps it open.
  const chatVisible = inCall && (showChat || textOnlyMode);

  // Unread badge and toast: partner messages that arrived while the chat was closed.
  const [seenCount, setSeenCount] = useState(0);
  const [toast, setToast] = useState<ChatEntry | null>(null);
  const messageCount = state.messages.length;
  useEffect(() => {
    if (chatVisible) {
      setSeenCount(messageCount);
      setToast(null);
    }
  }, [chatVisible, messageCount]);
  useEffect(() => {
    setSeenCount(0);
    setToast(null);
  }, [state.roomId]);
  const lastToastedId = useRef<string | null>(null);
  useEffect(() => {
    if (chatVisible || messageCount === 0) return;
    const last = state.messages[messageCount - 1];
    if (last?.from !== "partner" || last.id === lastToastedId.current) return;
    lastToastedId.current = last.id;
    setToast(last);
  }, [chatVisible, messageCount, state.messages]);
  const unreadCount = useMemo(
    () => state.messages.slice(seenCount).filter((m) => m.from === "partner").length,
    [state.messages, seenCount],
  );
  const dismissToast = useCallback(() => setToast(null), []);

  // The phone chat sheet sits on top of the action bar, whatever its height; on landscape
  // phones the bar is a right rail, and the captions overlay stays clear of its width.
  const actionBarRef = useRef<HTMLDivElement>(null);
  const [actionBarSize, setActionBarSize] = useState({ width: 0, height: 0 });
  const showActionBar = inCall || instantConnecting;
  useLayoutEffect(() => {
    const el = actionBarRef.current;
    if (!el || desktop || typeof ResizeObserver === "undefined") {
      setActionBarSize({ width: 0, height: 0 });
      return;
    }
    const measure = () => setActionBarSize({ width: el.offsetWidth, height: el.offsetHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [desktop, showActionBar]);

  // The call (timer, and coins on the server) starts when the media connects, not at call:start.
  const callConnectedAt = inCall ? peer.connectedAt : null;
  const { reportConnected } = signaling;
  useEffect(() => {
    if (callConnectedAt !== null) reportConnected();
  }, [callConnectedAt, reportConnected]);

  const connectionFailed = inCall && (peer.connectionState === "failed" || peer.failure !== null);
  const privateAllowed = inCall && !!state.callMedia?.privateModeAllowed;
  // Text chat still works without media, so a user in text-only mode is never skipped for it.
  // Normally the connect monitor's call:failed ends the call first; this is the fallback.
  const autoSkip = connectionFailed && !textOnlyMode;
  const { skip } = signaling;
  useEffect(() => {
    if (!autoSkip) return;
    const t = setTimeout(skip, FAILED_SKIP_MS + (state.initiator ? 0 : FAILED_SKIP_STAGGER_MS));
    return () => clearTimeout(t);
  }, [autoSkip, state.initiator, skip]);
  const noticeKey = state.notice ? NOTICE_KEYS[state.notice] : undefined;

  const sharedTopic = useMemo(() => {
    const topic = state.partner?.topics.find((candidate) => profile.topics.includes(candidate));
    return topic ? t(`landing:topics.${topic}`, { defaultValue: topic }) : null;
  }, [state.partner, profile.topics, t]);

  const chatPanel = inCall && (
    <ChatPanel
      messages={state.messages}
      partnerTyping={state.partnerTyping}
      textOnly={textOnlyMode}
      onClose={textOnlyMode ? undefined : () => setShowChat(false)}
      onSend={handleSend}
      onTyping={signaling.setTyping}
      redactedIds={safety.redactedIds}
      safetyNotice={safety.chatNudge ? t(NUDGE_KEYS[safety.chatNudge].body, { ns: "safety" }) : null}
    />
  );

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-gray-900 lg:flex-row" style={{ height: "100dvh" }}>
      {/* Stage: the partner's video full-bleed, everything else floats over it. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
          {inCall && (
            <VideoTile
              stream={peer.remoteStream}
              muted={false}
              hidden={textOnlyMode}
              testId="remote-video"
              loadingLabel={connectionFailed ? undefined : t("connecting.video")}
              blurred={remoteBlurred}
              onVideoElement={setRemoteVideo}
            />
          )}

          {/* The partner's live captions sit over the remote video, clear of the action bar (a right rail on landscape phones). */}
          {inCall && !textOnlyMode && (
            <CaptionsOverlay
              captions={captions}
              style={
                landscape && !desktop
                  ? { bottom: "calc(env(safe-area-inset-bottom) + 0.75rem)", right: `calc(${actionBarSize.width}px + 0.5rem)` }
                  : { bottom: `calc(${actionBarSize.height}px + 0.75rem)` }
              }
            />
          )}

          {inCall && !textOnlyMode && !connectionFailed && peer.remoteStream && (
            <div className="absolute inset-x-0 bottom-0 top-[calc(env(safe-area-inset-top)+3.5rem)]">
              <RemoteBlurOverlay
                status={blur.status}
                onReveal={blur.reveal}
                onReport={() => setShowSettings(true)}
                onNext={signaling.skip}
              />
            </div>
          )}

          {inCall && !textOnlyMode && state.roomId && <Watermark roomId={state.roomId} />}

          {inCall && textOnlyMode && (
            <TextOnlyPanel
              partner={state.partner}
              partnerTyping={state.partnerTyping}
              micEnabled={micEnabled}
              onSwitchToVideo={leaveTextOnly}
            />
          )}

          {/* Your own camera: the backdrop while waiting, a draggable picture-in-picture in a call. */}
          {!(textOnlyMode && inCall) && (
            <div
              className={
                pipActive
                  ? `h-32 w-24 overflow-hidden rounded-xl border-2 border-black bg-black shadow-[0_3px_0_#000] lg:h-52 lg:w-40 ${
                      localIsSpeaking ? "ring-2 ring-yellow-400" : ""
                    }`
                  : "absolute inset-0 opacity-50"
              }
              style={pip.style}
              data-testid={pipActive ? "local-pip" : "local-preview"}
              {...pip.handlers}
            >
              <VideoTile stream={localStream} mirrored={frontCamera} muted testId="local-video" />
              {faceGate.paused && pipActive && (
                <span className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-black/70 py-1" style={{ zIndex: 6 }} aria-hidden="true">
                  <VideoOff className="h-4 w-4 text-yellow-400" />
                </span>
              )}
            </div>
          )}

          {/* Status strip under the top bar: notices, face gate, Hide my IP. */}
          <div
            className="pointer-events-none absolute inset-x-0 z-[34] flex flex-col items-center gap-2 px-3"
            style={{ top: "calc(env(safe-area-inset-top) + 4rem)" }}
          >
            {noticeKey && (
              <StatusChip tone="warn">
                <span className="pointer-events-auto">{t(noticeKey)}</span>
              </StatusChip>
            )}
            {filterOff && (
              <StatusChip tone="warn" testId="gender-filter-off">
                <span className="pointer-events-auto">{t("premium:filterOff")}</span>
                <button
                  type="button"
                  className="pointer-events-auto rounded-full bg-yellow-400 px-2 py-0.5 text-xs font-semibold text-black"
                  onClick={() => {
                    setFilterOff(false);
                    genderGate.openUnlockSheet();
                  }}
                >
                  {t("premium:filterOffAction")}
                </button>
              </StatusChip>
            )}
            {faceGate.paused && inCall && !textOnlyMode && (
              <StatusChip testId="face-paused">
                <VideoOff className="h-4 w-4 shrink-0 text-yellow-400" aria-hidden="true" />
                {t("camera.facePaused")}
              </StatusChip>
            )}
            {inCall && peer.privateMode && (
              <StatusChip tone="ok" testId="private-badge" role="note">
                <Lock className="h-4 w-4" aria-hidden="true" />
                {t("privacy.ipHidden")}
              </StatusChip>
            )}
            {inCall && peer.privateRequested && !peer.privateMode && (
              <StatusChip tone="warn" testId="private-unavailable">
                {t("privacy.unavailable")}
              </StatusChip>
            )}
            {inCall && peer.lowBandwidth && <StatusChip tone="warn">{t("privacy.lowBandwidth")}</StatusChip>}
            {privateAllowed && onHideIpChange && (
              <div className="pointer-events-auto w-full max-w-sm rounded-xl bg-black/70 p-3 text-white backdrop-blur-sm">
                <HideIpToggle
                  checked={hideIp}
                  onChange={onHideIpChange}
                  note={hideIp !== peer.privateRequested ? t("privacy.appliesNextCall") : undefined}
                />
              </div>
            )}
          </div>

          {connectionFailed && !textOnlyMode && (
            <div className="video-loading-overlay" role="alert">
              <div className="space-y-4 px-4 text-center text-white">
                <WifiOff className="mx-auto h-12 w-12 text-red-400" aria-hidden="true" />
                <p className="text-lg font-medium">{t("callFailed.title")}</p>
                <p className="text-sm text-gray-300">{t("callFailed.body")}</p>
                <button type="button" onClick={signaling.skip} className="retro-button">
                  {t("callFailed.skip")}
                </button>
              </div>
            </div>
          )}

          {instantConnecting && state.partner && <ConnectingPanel partner={state.partner} />}

          {matchPhase && !instantConnecting && state.partner && (
            <MatchPrompt
              partner={state.partner}
              myTopics={profile.topics}
              isFriend={state.isFriend}
              expiresAt={state.expiresAt}
              accepted={state.status === "starting-call"}
              partnerAccepted={state.partnerAccepted}
              onAccept={signaling.accept}
              onDecline={signaling.decline}
              onReport={() => safety.openReport("match")}
            />
          )}

          {!inCall && !matchPhase && (
            <WaitingPanel
              status={state.status}
              reconnecting={state.reconnecting}
              lastEndReason={state.lastEndReason}
              error={state.error}
              photo={profile.photo}
              topics={profile.topics}
              relaxStep={state.relaxStep}
              online={state.online}
              onRetry={signaling.retry}
              onSearch={signaling.search}
              onHome={onBackToHome}
            />
          )}

          <RoomHeader
            coins={state.coins}
            coinBump={state.coinBump}
            isFriend={state.isFriend}
            inCall={inCall}
            callStartedAt={callConnectedAt}
            quality={connectionFailed ? "DISCONNECTED" : peer.quality}
            reconnecting={state.reconnecting}
            partner={inCall || matchPhase ? state.partner : null}
            sharedTopic={sharedTopic}
            partnerSpeaking={inCall && remoteIsSpeaking}
            onHome={onBackToHome}
            onSettings={() => setShowSettings(true)}
          />

          <ShortcutHint active={desktop && inCall} />

          {/* Phones: the action bar floats over the bottom of the stage. */}
          {showActionBar && !desktop && (
            <CallActionBar
              ref={actionBarRef}
              onNext={signaling.skip}
              onStop={onBackToHome}
              chatOpen={chatVisible}
              unreadCount={unreadCount}
              onToggleChat={() => setShowChat((v) => !v)}
              onReport={() => safety.openReport("call")}
              micEnabled={micEnabled}
              onToggleMic={toggleMic}
              textOnly={textOnlyMode}
              onToggleTextOnly={textOnlyMode ? leaveTextOnly : enterTextOnly}
              onFlipCamera={onFlipCamera}
              frontCamera={frontCamera}
              connecting={instantConnecting}
              spark={spark}
              captions={captions}
            />
          )}
        </div>

        {/* Desktop: the same bar sits under the video. */}
        {showActionBar && desktop && (
          <CallActionBar
            onNext={signaling.skip}
            onStop={onBackToHome}
            chatOpen={chatVisible}
            unreadCount={unreadCount}
            onToggleChat={() => setShowChat((v) => !v)}
            onReport={() => safety.openReport("call")}
            micEnabled={micEnabled}
            onToggleMic={toggleMic}
            textOnly={textOnlyMode}
            onToggleTextOnly={textOnlyMode ? leaveTextOnly : enterTextOnly}
            onFlipCamera={onFlipCamera}
            frontCamera={frontCamera}
            connecting={instantConnecting}
            spark={spark}
            captions={captions}
          />
        )}
      </div>

      {/* Desktop: chat as a side column. Phones: a sheet over the video. */}
      {desktop ? (
        chatVisible && (
          <aside className="hidden w-80 shrink-0 border-l-2 border-black lg:block xl:w-96" aria-label={t("chat.title")}>
            {chatPanel}
          </aside>
        )
      ) : (
        <ChatSheet
          open={chatVisible}
          dismissable={!textOnlyMode}
          landscape={landscape}
          bottomOffset={actionBarSize.height}
          title={t("chat.title")}
          onClose={() => setShowChat(false)}
        >
          {chatPanel}
        </ChatSheet>
      )}

      {toast && !chatVisible && (
        <ChatToast
          message={toast}
          partnerName={state.partner?.name ?? t("textOnly.stranger")}
          onOpen={() => setShowChat(true)}
          onDismiss={dismissToast}
        />
      )}

      <ChatSettings
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        preferences={preferences}
        onUpdatePreferences={handleUpdatePreferences}
      />

      {safety.target && (
        <ReportSheet
          key={`${safety.target.context}-${safety.target.roomId}`}
          target={safety.target}
          onSubmit={safety.submitReport}
          onClose={safety.closeReport}
        />
      )}
      {safety.postCall && !safety.target && (
        <PostCallReport
          postCall={safety.postCall}
          onReport={safety.openPostCallReport}
          onDismiss={safety.dismissPostCall}
        />
      )}
      {safety.nudge && (
        <NudgeToast
          nudge={safety.nudge}
          onDismiss={safety.dismissNudge}
          onReport={inCall && state.roomId === safety.nudge.roomId ? () => safety.openReport("call") : undefined}
        />
      )}
      {roomGate.overlay}
      <SparkCard spark={spark} />
    </div>
  );
};
