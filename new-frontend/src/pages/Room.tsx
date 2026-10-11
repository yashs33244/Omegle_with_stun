import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader, Lock, MessageCircle, Mic, MicOff, SkipForward, SwitchCamera, UserRound, Video, VideoOff, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/retroui/Button";
import { ChatSettings } from "@/components/ChatSettings";
import { ChatPanel, PartnerTyping } from "@/components/room/ChatPanel";
import { HideIpToggle } from "@/components/room/HideIpToggle";
import { MatchPrompt } from "@/components/room/MatchPrompt";
import { RoomHeader } from "@/components/room/RoomHeader";
import { VideoTile } from "@/components/room/VideoTile";
import { WaitingPanel } from "@/components/room/WaitingPanel";
import { NudgeToast } from "@/components/safety/NudgeToast";
import { PostCallReport } from "@/components/safety/PostCallReport";
import { ReportButton } from "@/components/safety/ReportButton";
import { ReportSheet } from "@/components/safety/ReportSheet";
import { SafetyCoachGate } from "@/components/safety/SafetyCoachCard";
import { NUDGE_KEYS } from "@/components/safety/safetyText";
import { useCallSafety } from "@/components/safety/useCallSafety";
import { Watermark } from "@/components/safety/Watermark";
import { useAudioLevelDetection } from "@/hooks/useAudioLevelDetection";
import { useIsMobile } from "@/hooks/use-mobile";
import { useNextShortcut } from "@/hooks/useNextShortcut";
import { usePeerConnection } from "@/hooks/usePeerConnection";
import { usePipDrag } from "@/hooks/usePipDrag";
import { useSignaling } from "@/hooks/useSignaling";
import { useWakeLock } from "@/hooks/useWakeLock";
import { getCountryByCode } from "@/lib/data";
import { useRoomGate } from "@/pages/gate/useRoomGate";
import type { ErrorCode, MatchMode, ModerationSignalPayload, Preferences, Profile, PublicProfile, SimpleAck } from "@/lib/protocol";
import { RemoteBlurOverlay } from "@/moderation/RemoteBlurOverlay";
import { isBlurred } from "@/moderation/blurGate";
import { useFaceGate } from "@/moderation/useFaceGate";
import { useRemoteBlur } from "@/moderation/useRemoteBlur";
import { activeCameraLabel, isVirtualCameraLabel } from "@/moderation/virtualCamera";

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
    <div className="w-full h-full min-h-[240px] bg-black flex items-center justify-center p-4" style={{ zIndex: 3 }} data-testid="instant-connecting">
      <div className="text-center text-white space-y-3">
        <Loader className="w-10 h-10 text-yellow-400 animate-spin mx-auto" aria-hidden="true" />
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

type NoticeKey = `notice.${"rateLimited" | "notInRoom" | "invalidPayload" | "internal"}`;

const NOTICE_KEYS: Partial<Record<ErrorCode, NoticeKey>> = {
  rate_limited: "notice.rateLimited",
  not_in_room: "notice.notInRoom",
  invalid_payload: "notice.invalidPayload",
  internal: "notice.internal",
};

const NameBadge: React.FC<{ name: string; country: string }> = ({ name, country }) => {
  const countryData = getCountryByCode(country);
  return (
    <div className="bg-black bg-opacity-80 backdrop-blur-sm text-white px-4 py-2 rounded-full flex items-center gap-2">
      <UserRound className="w-4 h-4" />
      <span className="text-sm font-medium truncate min-w-0 max-w-[10rem]">{name}</span>
      {countryData && <span className="text-sm">{countryData.flag}</span>}
    </div>
  );
};

const MicToggle: React.FC<{ micEnabled: boolean; onToggle: () => void; showLabel?: boolean }> = ({
  micEnabled,
  onToggle,
  showLabel = false,
}) => {
  const { t } = useTranslation("room");
  return (
    <Button
      onClick={onToggle}
      variant="outline"
      size="sm"
      aria-label={micEnabled ? t("mic.mute") : t("mic.unmute")}
      aria-pressed={!micEnabled}
      data-testid="mic-toggle"
      className={`flex items-center gap-2 ${
        micEnabled ? "bg-black bg-opacity-60 text-white border-white" : "bg-red-600 text-white border-red-500"
      }`}
    >
      {micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
      {showLabel && <span aria-hidden="true">{micEnabled ? t("mic.on") : t("mic.off")}</span>}
    </Button>
  );
};

const TextOnlyPanel: React.FC<{
  partner: PublicProfile | null;
  partnerTyping: boolean;
  micEnabled: boolean;
  onToggleMic: () => void;
  onSwitchToVideo: () => void;
}> = ({ partner, partnerTyping, micEnabled, onToggleMic, onSwitchToVideo }) => {
  const { t } = useTranslation("room");
  return (
    <div className="flex-1 flex flex-col justify-center items-center text-center space-y-4">
      <MessageCircle className="w-16 h-16 text-yellow-400" />
      <div className="text-white space-y-2">
        <h3 className="text-xl font-bold">{t("textOnly.title")}</h3>
        <p className="text-gray-300">{t("textOnly.chattingWith", { name: partner?.name || t("textOnly.stranger") })}</p>
        <p className="text-sm text-gray-400">{micEnabled ? t("textOnly.cameraOff") : t("textOnly.cameraAndMicOff")}</p>
        {partnerTyping && <PartnerTyping />}
      </div>
      <div className="flex items-center gap-3">
        <MicToggle micEnabled={micEnabled} onToggle={onToggleMic} showLabel />
        <Button onClick={onSwitchToVideo} variant="outline" className="bg-yellow-500 text-black hover:bg-yellow-400">
          <Video className="w-4 h-4 mr-2" />
          {t("textOnly.switchToVideo")}
        </Button>
      </div>
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
  const { t } = useTranslation(["room", "safety"]);
  const isMobile = useIsMobile();
  const [preferences, setPreferences] = useState<Preferences>(initialPreferences);
  const signaling = useSignaling(profile, initialPreferences, { mode });
  const { state, updatePreferences, send } = signaling;
  const remoteTileRef = useRef<HTMLDivElement>(null);
  const safety = useCallSafety(signaling, () =>
    remoteTileRef.current?.querySelector<HTMLVideoElement>('video[data-testid="remote-video"]') ?? null,
  );

  const inCall = state.status === "in-call";
  const matchPhase = state.status === "match-found" || state.status === "starting-call";
  const callRoomId = inCall ? state.roomId : null;

  const [showChat, setShowChat] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [textOnlyMode, setTextOnlyMode] = useState(false);
  /** Entering text-only muted the mic, and the user has not touched it since. */
  const textOnlyMutedMicRef = useRef(false);

  // Text-only mutes the mic too; its toggle moves into the text panel.
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
  const pip = usePipDrag(isMobile && inCall && !textOnlyMode);
  const instantConnecting = matchPhase && state.matchMode === "instant";

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

  const handleSend = (text: string) => {
    void signaling.sendChat(text).then(safety.noteChatAck);
  };

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
  // Length of the border beam: whatever is left of the accept window when the match arrives.
  const beamSeconds = useMemo(
    () => (state.expiresAt !== null ? Math.max(0, (state.expiresAt - Date.now()) / 1000) : 0),
    [state.expiresAt],
  );
  const beamStyle = matchPhase && beamSeconds > 0 ? ({ "--beam-duration": `${beamSeconds}s` } as React.CSSProperties) : undefined;
  const noticeKey = state.notice ? NOTICE_KEYS[state.notice] : undefined;

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <RoomHeader
        isMobile={isMobile}
        coins={state.coins}
        coinBump={state.coinBump}
        isFriend={state.isFriend}
        inCall={inCall}
        callStartedAt={callConnectedAt}
        quality={connectionFailed ? "DISCONNECTED" : peer.quality}
        reconnecting={state.reconnecting}
        onHome={onBackToHome}
        onSettings={() => setShowSettings(true)}
        onSkip={signaling.skip}
      />

      {noticeKey && (
        <div role="status" className="bg-orange-600 text-white text-sm text-center py-1">
          {t(noticeKey)}
        </div>
      )}

      {inCall && (privateAllowed || peer.privateRequested || peer.lowBandwidth || onFlipCamera) && (
        <div className="flex flex-wrap items-center gap-3 px-4 py-2 bg-black bg-opacity-70 text-white border-b border-gray-700">
          {peer.privateMode && (
            <span className="flex items-center gap-1 text-xs text-green-400" data-testid="private-badge">
              <Lock className="w-4 h-4" aria-hidden="true" />
              {t("privacy.ipHidden")}
            </span>
          )}
          {peer.privateRequested && !peer.privateMode && (
            <span className="text-xs text-orange-300" role="status" data-testid="private-unavailable">
              {t("privacy.unavailable")}
            </span>
          )}
          {privateAllowed && onHideIpChange && (
            <HideIpToggle
              checked={hideIp}
              onChange={onHideIpChange}
              note={hideIp !== peer.privateRequested ? t("privacy.appliesNextCall") : undefined}
            />
          )}
          {peer.lowBandwidth && (
            <span className="text-xs text-orange-300" role="status">
              {t("privacy.lowBandwidth")}
            </span>
          )}
          {onFlipCamera && !textOnlyMode && (
            <Button
              onClick={onFlipCamera}
              variant="outline"
              size="sm"
              aria-label={frontCamera ? t("camera.switchToBack") : t("camera.switchToFront")}
              data-testid="flip-camera"
              className="ml-auto bg-black bg-opacity-60 text-white border-white"
            >
              <SwitchCamera className="w-4 h-4" />
            </Button>
          )}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex relative">
        <div
          className={`flex-1 grid ${
            textOnlyMode && inCall
              ? "grid-cols-1 gap-4 p-4"
              : isMobile
                ? "grid-cols-1 gap-2 p-2"
                : showChat
                  ? "lg:grid-cols-2 gap-4 p-4"
                  : "grid-cols-2 gap-4 p-4"
          }`}
        >
          {/* Local Video */}
          {!(textOnlyMode && inCall) && (
            <div
              className={`retro-video-card ${localIsSpeaking ? "speaking" : ""} ${pip.style ? "!w-28 !h-40 !min-h-0" : ""}`}
              style={pip.style}
              data-testid={pip.style ? "local-pip" : undefined}
              {...pip.handlers}
            >
              <VideoTile stream={localStream} mirrored={frontCamera} muted testId="local-video" />

              {faceGate.paused && (
                <div
                  className="absolute inset-x-2 top-2 bg-black bg-opacity-80 text-white text-xs rounded px-2 py-1 flex items-center gap-2"
                  style={{ zIndex: 6 }}
                  role="status"
                  data-testid="face-paused"
                >
                  <VideoOff className="w-4 h-4 shrink-0 text-yellow-400" aria-hidden="true" />
                  {t("camera.facePaused")}
                </div>
              )}

              {!pip.style && (
                <div className="absolute bottom-4 left-4 flex items-center gap-2" style={{ zIndex: 5 }}>
                  {profile.photo && (
                    <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-white">
                      <img src={profile.photo} alt={t("camera.profileAlt")} className="w-full h-full object-cover" />
                    </div>
                  )}
                  <NameBadge name={profile.name} country={profile.country} />
                </div>
              )}

              <div className={`absolute ${pip.style ? "bottom-1 right-1" : "bottom-4 right-4"}`} style={{ zIndex: 5 }}>
                <MicToggle micEnabled={micEnabled} onToggle={toggleMic} />
              </div>

              {/* Chat toggle button */}
              {inCall && (
                <div className={`absolute ${pip.style ? "top-1 right-1" : "top-4 right-4"}`} style={{ zIndex: 5 }}>
                  <Button
                    onClick={() => setShowChat((v) => !v)}
                    variant={showChat ? "default" : "outline"}
                    size="sm"
                    data-testid="chat-toggle"
                    aria-pressed={showChat}
                    aria-label={t("chat.toggle")}
                    className={`flex items-center gap-2 ${
                      showChat ? "bg-yellow-500 text-black" : "bg-black bg-opacity-60 text-white border-white"
                    }`}
                  >
                    <MessageCircle className="w-4 h-4" />
                    {!pip.style && t("chat.toggle")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Remote Video / Text Chat Area */}
          <div
            ref={remoteTileRef}
            className={
              textOnlyMode && inCall
                ? "relative bg-gray-800 rounded-lg p-6 border border-gray-700 h-full flex flex-col"
                : `retro-video-card ${remoteIsSpeaking && inCall ? "speaking" : ""} ${
                    matchPhase && beamSeconds > 0 ? "timer-border-beam" : ""
                  }`
            }
            style={beamStyle}
          >
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

            {inCall && !textOnlyMode && !connectionFailed && peer.remoteStream && (
              <RemoteBlurOverlay
                status={blur.status}
                onReveal={blur.reveal}
                onReport={() => setShowSettings(true)}
                onNext={signaling.skip}
              />
            )}

            {inCall && !textOnlyMode && state.roomId && <Watermark roomId={state.roomId} />}

            {inCall && (
              <div className="absolute top-4 right-4" style={{ zIndex: 6 }}>
                <ReportButton onClick={() => safety.openReport("call")} />
              </div>
            )}

            {inCall && textOnlyMode && (
              <TextOnlyPanel
                partner={state.partner}
                partnerTyping={state.partnerTyping}
                micEnabled={micEnabled}
                onToggleMic={toggleMic}
                onSwitchToVideo={leaveTextOnly}
              />
            )}

            {inCall && !textOnlyMode && (
              <>
                {state.partner && (
                  <div className="absolute bottom-4 left-4" style={{ zIndex: 5 }}>
                    <NameBadge name={state.partner.name} country={state.partner.country} />
                  </div>
                )}
                <div className="absolute top-4 left-4" style={{ zIndex: 5 }}>
                  <Button
                    onClick={enterTextOnly}
                    variant="outline"
                    size="sm"
                    data-testid="text-only-toggle"
                    className="bg-black bg-opacity-60 text-white border-white hover:bg-gray-800"
                  >
                    <MessageCircle className="w-4 h-4 mr-2" />
                    {t("textOnly.toggle")}
                  </Button>
                </div>
              </>
            )}

            {connectionFailed && !textOnlyMode && (
              <div className="video-loading-overlay" role="alert">
                <div className="text-center text-white space-y-4 px-4">
                  <WifiOff className="w-12 h-12 text-red-400 mx-auto" />
                  <p className="text-lg font-medium">{t("callFailed.title")}</p>
                  <p className="text-sm text-gray-300">{t("callFailed.body")}</p>
                  <button type="button" onClick={signaling.skip} className="retro-button">
                    {t("callFailed.skip")}
                  </button>
                </div>
              </div>
            )}

            {instantConnecting && state.partner && <ConnectingPanel partner={state.partner} />}

            {(inCall || instantConnecting) && (
              <div className="absolute bottom-4 right-4" style={{ zIndex: 25 }}>
                <button
                  type="button"
                  onClick={signaling.skip}
                  data-testid="next-button"
                  aria-keyshortcuts="Escape ArrowRight"
                  title={t("next.title")}
                  className="retro-button bg-orange-500 text-white text-lg px-6 py-3 flex items-center gap-2"
                >
                  <SkipForward className="w-6 h-6" aria-hidden="true" />
                  {t("next.label")}
                </button>
              </div>
            )}

            {matchPhase && !instantConnecting && state.partner && (
              <MatchPrompt
                partner={state.partner}
                isFriend={state.isFriend}
                expiresAt={state.expiresAt}
                accepted={state.status === "starting-call"}
                partnerAccepted={state.partnerAccepted}
                onAccept={signaling.accept}
                onDecline={signaling.decline}
              />
            )}

            {matchPhase && state.partner && (
              <div className="absolute top-4 left-4" style={{ zIndex: 6 }}>
                <ReportButton testId="match-report-button" onClick={() => safety.openReport("match")} />
              </div>
            )}

            {!inCall && !matchPhase && (
              <WaitingPanel
                status={state.status}
                reconnecting={state.reconnecting}
                lastEndReason={state.lastEndReason}
                error={state.error}
                photo={profile.photo}
                topics={profile.topics}
                onRetry={signaling.retry}
                onSearch={signaling.search}
                onHome={onBackToHome}
              />
            )}
          </div>
        </div>

        {/* Chat Panel: always shown in text-only mode */}
        {inCall && (showChat || textOnlyMode) && (
          <ChatPanel
            messages={state.messages}
            partnerTyping={state.partnerTyping}
            textOnly={textOnlyMode}
            isMobile={isMobile}
            onClose={() => setShowChat(false)}
            onSend={handleSend}
            onTyping={signaling.setTyping}
            redactedIds={safety.redactedIds}
            safetyNotice={safety.chatNudge ? t(NUDGE_KEYS[safety.chatNudge].body, { ns: "safety" }) : null}
          />
        )}

        <ChatSettings
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          preferences={preferences}
          onUpdatePreferences={handleUpdatePreferences}
        />
      </div>

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
    </div>
  );
};
