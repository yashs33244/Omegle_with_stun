import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle, Mic, MicOff, UserRound, Video, WifiOff } from "lucide-react";
import { Button } from "@/components/retroui/Button";
import { ChatSettings } from "@/components/ChatSettings";
import { ChatPanel, PartnerTyping } from "@/components/room/ChatPanel";
import { MatchPrompt } from "@/components/room/MatchPrompt";
import { RoomHeader } from "@/components/room/RoomHeader";
import { VideoTile } from "@/components/room/VideoTile";
import { WaitingPanel } from "@/components/room/WaitingPanel";
import { useAudioLevelDetection } from "@/hooks/useAudioLevelDetection";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePeerConnection } from "@/hooks/usePeerConnection";
import { useSignaling } from "@/hooks/useSignaling";
import { getCountryByCode } from "@/lib/data";
import type { ErrorCode, Preferences, Profile, PublicProfile, SimpleAck } from "@/lib/protocol";

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
}

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

const MicToggle: React.FC<{ micEnabled: boolean; onToggle: () => void; showLabel?: boolean }> = ({
  micEnabled,
  onToggle,
  showLabel = false,
}) => (
  <Button
    onClick={onToggle}
    variant="outline"
    size="sm"
    aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"}
    aria-pressed={!micEnabled}
    data-testid="mic-toggle"
    className={`flex items-center gap-2 ${
      micEnabled ? "bg-black bg-opacity-60 text-white border-white" : "bg-red-600 text-white border-red-500"
    }`}
  >
    {micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
    {showLabel && <span aria-hidden="true">{micEnabled ? "Mic on" : "Mic off"}</span>}
  </Button>
);

const TextOnlyPanel: React.FC<{
  partner: PublicProfile | null;
  partnerTyping: boolean;
  micEnabled: boolean;
  onToggleMic: () => void;
  onSwitchToVideo: () => void;
}> = ({ partner, partnerTyping, micEnabled, onToggleMic, onSwitchToVideo }) => (
  <div className="flex-1 flex flex-col justify-center items-center text-center space-y-4">
    <MessageCircle className="w-16 h-16 text-yellow-400" />
    <div className="text-white space-y-2">
      <h3 className="text-xl font-bold">Text Chat Mode</h3>
      <p className="text-gray-300">You're chatting with {partner?.name || "a stranger"}</p>
      <p className="text-sm text-gray-400">
        {micEnabled ? "Your camera is off, but they can still hear you." : "Your camera and microphone are off."}
      </p>
      {partnerTyping && <PartnerTyping />}
    </div>
    <div className="flex items-center gap-3">
      <MicToggle micEnabled={micEnabled} onToggle={onToggleMic} showLabel />
      <Button onClick={onSwitchToVideo} variant="outline" className="bg-yellow-500 text-black hover:bg-yellow-400">
        <Video className="w-4 h-4 mr-2" />
        Switch to Video
      </Button>
    </div>
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
}) => {
  const isMobile = useIsMobile();
  const [preferences, setPreferences] = useState<Preferences>(initialPreferences);
  const signaling = useSignaling(profile, initialPreferences);
  const { state, updatePreferences } = signaling;

  const inCall = state.status === "in-call";
  const matchPhase = state.status === "match-found" || state.status === "starting-call";

  const peer = usePeerConnection({
    roomId: inCall ? state.roomId : null,
    initiator: inCall ? state.initiator : null,
    iceServers: state.iceServers,
    localStream,
    sendSignal: signaling.sendSignal,
    subscribeSignals: signaling.subscribeSignals,
  });

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
    void signaling.sendChat(text);
  };

  const connectionFailed = inCall && peer.connectionState === "failed";
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

      {/* Main content */}
      <div className="flex-1 flex">
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
            <div className={`retro-video-card ${localIsSpeaking ? "speaking" : ""}`}>
              <VideoTile stream={localStream} mirrored muted testId="local-video" />

              <div className="absolute bottom-4 left-4 flex items-center gap-2" style={{ zIndex: 5 }}>
                {profile.photo && (
                  <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-white">
                    <img src={profile.photo} alt="Your profile" className="w-full h-full object-cover" />
                  </div>
                )}
                <NameBadge name={profile.name} country={profile.country} />
              </div>

              <div className="absolute bottom-4 right-4" style={{ zIndex: 5 }}>
                <MicToggle micEnabled={micEnabled} onToggle={toggleMic} />
              </div>

              {/* Chat toggle button */}
              {inCall && (
                <div className="absolute top-4 right-4" style={{ zIndex: 5 }}>
                  <Button
                    onClick={() => setShowChat((v) => !v)}
                    variant={showChat ? "default" : "outline"}
                    size="sm"
                    data-testid="chat-toggle"
                    aria-pressed={showChat}
                    className={`flex items-center gap-2 ${
                      showChat ? "bg-yellow-500 text-black" : "bg-black bg-opacity-60 text-white border-white"
                    }`}
                  >
                    <MessageCircle className="w-4 h-4" />
                    Chat
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Remote Video / Text Chat Area */}
          <div
            className={
              textOnlyMode && inCall
                ? "bg-gray-800 rounded-lg p-6 border border-gray-700 h-full flex flex-col"
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
              />
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

            {matchPhase && state.partner && (
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
