import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader, Lock, MessageCircle, Mic, MicOff, SkipForward, SwitchCamera, UserRound, Video, VideoOff, WifiOff } from "lucide-react";
import { Button } from "@/components/retroui/Button";
import { ChatSettings } from "@/components/ChatSettings";
import { ChatPanel, PartnerTyping } from "@/components/room/ChatPanel";
import { HideIpToggle } from "@/components/room/HideIpToggle";
import { MatchPrompt } from "@/components/room/MatchPrompt";
import { RoomHeader } from "@/components/room/RoomHeader";
import { VideoTile } from "@/components/room/VideoTile";
import { WaitingPanel } from "@/components/room/WaitingPanel";
import { useAudioLevelDetection } from "@/hooks/useAudioLevelDetection";
import { useIsMobile } from "@/hooks/use-mobile";
import { useNextShortcut } from "@/hooks/useNextShortcut";
import { usePeerConnection } from "@/hooks/usePeerConnection";
import { usePipDrag } from "@/hooks/usePipDrag";
import { useSignaling } from "@/hooks/useSignaling";
import { useWakeLock } from "@/hooks/useWakeLock";
import { getCountryByCode } from "@/lib/data";
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
const ConnectingPanel: React.FC<{ partner: PublicProfile }> = ({ partner }) => (
  <div className="w-full h-full min-h-[240px] bg-black flex items-center justify-center p-4" style={{ zIndex: 3 }} data-testid="instant-connecting">
    <div className="text-center text-white space-y-3">
      <Loader className="w-10 h-10 text-yellow-400 animate-spin mx-auto" aria-hidden="true" />
      <p className="text-lg font-medium">Connecting you with {partner.name}...</p>
    </div>
  </div>
);

const NOTICE_TEXT: Partial<Record<ErrorCode, string>> = {
  rate_limited: "Slow down a little, you are sending too fast.",
  not_in_room: "That call has already ended.",
  invalid_payload: "The server rejected that request.",
  internal: "Something went wrong on the server.",
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

const TextOnlyPanel: React.FC<{ partner: PublicProfile | null; partnerTyping: boolean; onSwitchToVideo: () => void }> = ({
  partner,
  partnerTyping,
  onSwitchToVideo,
}) => (
  <div className="flex-1 flex flex-col justify-center items-center text-center space-y-4">
    <MessageCircle className="w-16 h-16 text-yellow-400" />
    <div className="text-white space-y-2">
      <h3 className="text-xl font-bold">Text Chat Mode</h3>
      <p className="text-gray-300">You're chatting with {partner?.name || "a stranger"}</p>
      {partnerTyping && <PartnerTyping />}
    </div>
    <Button onClick={onSwitchToVideo} variant="outline" className="bg-yellow-500 text-black hover:bg-yellow-400">
      <Video className="w-4 h-4 mr-2" />
      Switch to Video
    </Button>
  </div>
);

export const Room: React.FC<RoomProps> = ({
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
  const isMobile = useIsMobile();
  const [preferences, setPreferences] = useState<Preferences>(initialPreferences);
  const signaling = useSignaling(profile, initialPreferences, { mode });
  const { state, updatePreferences, send } = signaling;

  const inCall = state.status === "in-call";
  const matchPhase = state.status === "match-found" || state.status === "starting-call";
  const callRoomId = inCall ? state.roomId : null;

  const [showChat, setShowChat] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [textOnlyMode, setTextOnlyMode] = useState(false);

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
    setTextOnlyMode(false);
    setShowChat(false);
  }, [state.roomId]);

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
    void signaling.sendChat(text);
  };

  const connectionFailed = inCall && (peer.connectionState === "failed" || peer.failure !== null);
  const privateAllowed = inCall && !!state.callMedia?.privateModeAllowed;
  // Length of the border beam: whatever is left of the accept window when the match arrives.
  const beamSeconds = useMemo(
    () => (state.expiresAt !== null ? Math.max(0, (state.expiresAt - Date.now()) / 1000) : 0),
    [state.expiresAt],
  );
  const beamStyle = matchPhase && beamSeconds > 0 ? ({ "--beam-duration": `${beamSeconds}s` } as React.CSSProperties) : undefined;
  const notice = state.notice ? NOTICE_TEXT[state.notice] : undefined;

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <RoomHeader
        isMobile={isMobile}
        coins={state.coins}
        coinBump={state.coinBump}
        isFriend={state.isFriend}
        inCall={inCall}
        callStartedAt={state.callStartedAt}
        quality={connectionFailed ? "DISCONNECTED" : peer.quality}
        reconnecting={state.reconnecting}
        onHome={onBackToHome}
        onSettings={() => setShowSettings(true)}
        onSkip={signaling.skip}
      />

      {notice && (
        <div role="status" className="bg-orange-600 text-white text-sm text-center py-1">
          {notice}
        </div>
      )}

      {inCall && (privateAllowed || peer.privateMode || peer.lowBandwidth || onFlipCamera) && (
        <div className="flex flex-wrap items-center gap-3 px-4 py-2 bg-black bg-opacity-70 text-white border-b border-gray-700">
          {peer.privateMode && (
            <span className="flex items-center gap-1 text-xs text-green-400" data-testid="private-badge">
              <Lock className="w-4 h-4" aria-hidden="true" />
              IP hidden from your partner
            </span>
          )}
          {privateAllowed && onHideIpChange && (
            <HideIpToggle
              checked={hideIp}
              onChange={onHideIpChange}
              note={hideIp !== peer.privateMode ? "Applies from your next call." : undefined}
            />
          )}
          {peer.lowBandwidth && (
            <span className="text-xs text-orange-300" role="status">
              Weak connection: sending lower quality video.
            </span>
          )}
          {onFlipCamera && !textOnlyMode && (
            <Button
              onClick={onFlipCamera}
              variant="outline"
              size="sm"
              aria-label={frontCamera ? "Switch to the back camera" : "Switch to the front camera"}
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
                  Your face is out of frame, so your video is paused
                </div>
              )}

              {!pip.style && (
                <div className="absolute bottom-4 left-4 flex items-center gap-2" style={{ zIndex: 5 }}>
                  {profile.photo && (
                    <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-white">
                      <img src={profile.photo} alt="Your profile" className="w-full h-full object-cover" />
                    </div>
                  )}
                  <NameBadge name={profile.name} country={profile.country} />
                </div>
              )}

              <div className={`absolute ${pip.style ? "bottom-1 right-1" : "bottom-4 right-4"}`} style={{ zIndex: 5 }}>
                <Button
                  onClick={() => onMicEnabledChange(!micEnabled)}
                  variant="outline"
                  size="sm"
                  aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"}
                  aria-pressed={!micEnabled}
                  className={`flex items-center ${
                    micEnabled ? "bg-black bg-opacity-60 text-white border-white" : "bg-red-600 text-white border-red-500"
                  }`}
                >
                  {micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                </Button>
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
                    aria-label="Chat"
                    className={`flex items-center gap-2 ${
                      showChat ? "bg-yellow-500 text-black" : "bg-black bg-opacity-60 text-white border-white"
                    }`}
                  >
                    <MessageCircle className="w-4 h-4" />
                    {!pip.style && "Chat"}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Remote Video / Text Chat Area */}
          <div
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
                loadingLabel={connectionFailed ? undefined : "Connecting video..."}
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

            {inCall && textOnlyMode && (
              <TextOnlyPanel
                partner={state.partner}
                partnerTyping={state.partnerTyping}
                onSwitchToVideo={() => setTextOnlyMode(false)}
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
                    onClick={() => setTextOnlyMode(true)}
                    variant="outline"
                    size="sm"
                    data-testid="text-only-toggle"
                    className="bg-black bg-opacity-60 text-white border-white hover:bg-gray-800"
                  >
                    <MessageCircle className="w-4 h-4 mr-2" />
                    Text Only
                  </Button>
                </div>
              </>
            )}

            {connectionFailed && !textOnlyMode && (
              <div className="video-loading-overlay" role="alert">
                <div className="text-center text-white space-y-4 px-4">
                  <WifiOff className="w-12 h-12 text-red-400 mx-auto" />
                  <p className="text-lg font-medium">Couldn't connect the video</p>
                  <p className="text-sm text-gray-300">Your networks could not reach each other.</p>
                  <button type="button" onClick={signaling.skip} className="retro-button">
                    Skip to someone else
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
                  title="Next (Esc or Right arrow)"
                  className="retro-button bg-orange-500 text-white text-lg px-6 py-3 flex items-center gap-2"
                >
                  <SkipForward className="w-6 h-6" aria-hidden="true" />
                  Next
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

            {!inCall && !matchPhase && (
              <WaitingPanel
                status={state.status}
                reconnecting={state.reconnecting}
                lastEndReason={state.lastEndReason}
                error={state.error}
                photo={profile.photo}
                topics={profile.topics}
                onRetry={signaling.retry}
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
          />
        )}

        <ChatSettings
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          preferences={preferences}
          onUpdatePreferences={handleUpdatePreferences}
          onReport={signaling.report}
          canReport={inCall}
        />
      </div>
    </div>
  );
};
