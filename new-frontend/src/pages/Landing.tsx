import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Camera, Loader, Pencil, Settings, User, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { useMediaStream } from "../hooks/useMediaStream";
import { Footer } from "@/components/Footer";
import { trackOnce } from "@/lib/observability";
import { Button } from "@/components/retroui/Button";
import { CameraProblem } from "@/components/landing/CameraProblem";
import { ProfileEditor } from "@/components/landing/ProfileEditor";
import { StartSettings } from "@/components/landing/StartSettings";
import { StickyBar } from "@/components/ui/StickyBar";
import { getCountryByCode, getLanguageByCode } from "../lib/data";
import { FLAG_DEFAULTS, type MatchMode, type Preferences } from "../lib/protocol";
import { MatchModeToggle } from "@/components/MatchModeToggle";
import { PreflightCheck } from "@/components/room/PreflightCheck";
import { useStartOptions } from "@/hooks/useStartOptions";
import { useStreamVideo } from "@/hooks/useStreamVideo";
import { runningOnMobile } from "@/lib/mobile";
import { preloadModels } from "@/moderation/modelClient";
import { toProfile, type ProfileForm } from "../lib/profileForm";

// The call screen (signalling, WebRTC, moderation hooks, captions, Spark) is its
// own chunk: the start screen paints without it, and loadRoom() fetches it as
// soon as the gate has passed so Start does not wait for the network.
const loadRoom = () => import("./Room");
const Room = lazy(() => loadRoom().then((m) => ({ default: m.Room })));
const RoomFallback = () => <div className="h-screen w-full bg-gray-900" style={{ height: "100dvh" }} aria-busy="true" />;

export interface LandingProps {
  /** Server default for the match mode (GET /api/config defaultMode). */
  defaultMode?: MatchMode;
  /** Hide my IP is offered at all (GET /api/config privateModeEnabled). */
  privateModeEnabled?: boolean;
}

/**
 * The start screen. One screen on a phone: header, camera tile, profile row,
 * Instant/Preview, and Start pinned above the home indicator. Everything else
 * lives in the settings sheet; the profile editor opens from Start.
 */
export const Landing: React.FC<LandingProps> = ({
  defaultMode = FLAG_DEFAULTS.default_mode,
  privateModeEnabled = FLAG_DEFAULTS.private_mode_enabled,
}) => {
  const { t } = useTranslation(["landing", "room"]);
  const [step, setStep] = useState<"home" | "chat">("home");
  const startOptions = useStartOptions(defaultMode);
  const [isPhone] = useState(runningOnMobile);

  // Fetch the call screen now and download/compile the moderation models once
  // the start screen is idle, so neither competes with its first paint.
  useEffect(() => {
    void loadRoom();
    preloadModels();
  }, []);

  const [setupOpen, setSetupOpen] = useState(false);
  // Bumped on every open so the editor starts over at the right step.
  const [setupSession, setSetupSession] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [form, setForm] = useState<ProfileForm>({
    name: "",
    country: "IN",
    language: "en",
    gender: "unspecified",
    topics: ["general"],
  });
  const [preferences, setPreferences] = useState<Preferences>({
    genderFilter: "all",
    languageFilter: "any",
  });

  const {
    stream,
    hasPermission,
    isLoading,
    error,
    getCam,
    stopStream,
    micEnabled,
    setMicEnabled,
    setCameraEnabled,
    facingMode,
    flipCamera,
  } = useMediaStream();

  useEffect(() => {
    if (hasPermission) trackOnce("camera_granted");
  }, [hasPermission]);

  const [tileVideoRef] = useStreamVideo(stream);
  const profile = useMemo(() => toProfile(form), [form]);

  const retryCamera = useCallback(() => {
    void getCam();
  }, [getCam]);

  const patchForm = useCallback((patch: Partial<ProfileForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const openSetup = () => {
    setSetupSession((n) => n + 1);
    setSetupOpen(true);
  };

  const beginChat = () => {
    setSetupOpen(false);
    setStep("chat");
  };

  // Release the camera with the call, then start a fresh one for the home screen.
  const leaveRoom = useCallback(() => {
    stopStream();
    setStep("home");
    void getCam();
  }, [stopStream, getCam]);

  if (step === "chat") {
    return (
      <Suspense fallback={<RoomFallback />}>
        <Room
          profile={profile}
          preferences={preferences}
          onPreferencesChange={setPreferences}
          localStream={stream}
          micEnabled={micEnabled}
          onMicEnabledChange={setMicEnabled}
          onCameraEnabledChange={setCameraEnabled}
          onBackToHome={leaveRoom}
          mode={startOptions.mode}
          hideIp={startOptions.hideIp}
          onHideIpChange={startOptions.setHideIp}
          onFlipCamera={isPhone ? () => void flipCamera() : undefined}
          frontCamera={facingMode === "user"}
        />
      </Suspense>
    );
  }

  const countryData = getCountryByCode(form.country);
  const languageData = getLanguageByCode(form.language);
  const summary = [
    countryData && t(`countries.${countryData.code}`),
    languageData && t(`languages.${languageData.code}`),
    t("profile.topicsCount", { count: form.topics.length }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="bg-gray-900 text-white">
      {/* Everything above the footer fills the first screen, so the footer starts below the fold. */}
      <div className="min-h-app flex flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-2 px-4 pt-[max(var(--safe-top),0.5rem)] pb-2 bg-gray-900/95 backdrop-blur-sm border-b-2 border-black">
          <h1 className="text-2xl font-bold text-yellow-400 leading-none">{t("appName", { ns: "common" })}</h1>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label={t("settings.open")}
            data-testid="open-settings"
            className="flex h-tap w-tap items-center justify-center rounded-xl border-2 border-black bg-gray-800 text-white hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
          >
            <Settings className="w-5 h-5" aria-hidden="true" />
          </button>
        </header>

        <main className="flex-1 w-full max-w-5xl mx-auto px-4 pt-3 pb-3 flex flex-col gap-3 md:flex-row md:items-start md:gap-8 md:pt-8">
          {/* Camera tile with the permission state inside it */}
          <section aria-label={t("camera.preview")} className="md:flex-1 md:order-2 space-y-2">
            <div className="relative aspect-video w-full overflow-hidden rounded-xl border-2 border-black bg-black shadow-md">
              {stream && (
                <video
                  ref={tileVideoRef}
                  autoPlay
                  playsInline
                  muted
                  aria-hidden="true"
                  className="w-full h-full object-cover"
                  style={{ transform: "scaleX(-1)" }}
                />
              )}
              {!stream && (
                <div className="absolute inset-0 flex items-center justify-center">
                  {isLoading ? (
                    <div className="text-center text-white space-y-2" role="status">
                      <Loader className="w-8 h-8 animate-spin mx-auto" aria-hidden="true" />
                      <p className="text-sm">{t("camera.startingYours")}</p>
                    </div>
                  ) : error ? (
                    <CameraProblem error={error} onRetry={retryCamera} />
                  ) : (
                    <div className="text-center text-white space-y-3 px-4">
                      <Camera className="w-10 h-10 mx-auto text-gray-400" aria-hidden="true" />
                      <p className="text-sm">{t("camera.required")}</p>
                      <Button onClick={retryCamera} className="mx-auto min-h-tap bg-yellow-400 text-black hover:bg-yellow-300">
                        {t("camera.enable")}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-1 text-xs" role="status">
                <span aria-hidden="true" className={`w-2 h-2 rounded-full ${stream ? "bg-green-400" : "bg-red-400"}`} />
                <span>{stream ? t("camera.ready") : isLoading ? t("camera.starting") : t("camera.off")}</span>
              </div>
            </div>
            {stream && <PreflightCheck stream={stream} />}
          </section>

          <div className="md:w-80 md:order-1 md:shrink-0 space-y-3">
            {/* Profile row */}
            <div className="flex items-center gap-3 rounded-xl border-2 border-black bg-gray-800 p-2 pr-3">
              <button
                type="button"
                onClick={openSetup}
                aria-label={t("profile.editAria")}
                className="h-tap w-tap shrink-0 rounded-full bg-yellow-400 flex items-center justify-center overflow-hidden hover:bg-yellow-300 transition-colors"
              >
                {form.photo ? (
                  <img src={form.photo} alt="" className="w-full h-full object-cover" />
                ) : (
                  <User className="w-6 h-6 text-black" aria-hidden="true" />
                )}
              </button>
              <div className="min-w-0 flex-1">
                <p className="font-bold truncate leading-tight">{form.name.trim() || t("profile.guest")}</p>
                <p className="text-xs text-gray-300 truncate">
                  <span aria-hidden="true">{countryData?.flag} </span>
                  {summary}
                </p>
              </div>
              <button
                type="button"
                onClick={openSetup}
                data-testid="edit-profile"
                className="flex min-h-tap shrink-0 items-center gap-1 rounded-full border-2 border-black bg-white px-3 text-xs font-bold text-black hover:bg-gray-100"
              >
                <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                {t("profile.edit")}
              </button>
            </div>

            <MatchModeToggle mode={startOptions.mode} onChange={startOptions.setMode} />

            {preferences.genderFilter !== "all" && (
              <p className="flex items-center gap-1.5 text-xs text-gray-300" data-testid="gender-filter-note">
                <Users className="w-3.5 h-3.5" aria-hidden="true" />
                {t("profile.meeting", { gender: t(`room:settings.gender.${preferences.genderFilter}`) })}
              </p>
            )}
          </div>
        </main>

        {/* Phones: pinned above the home indicator. Desktop: a plain row under the two columns. */}
        <StickyBar className="md:static md:border-0 md:bg-transparent md:pb-8" data-testid="start-bar">
          <div className="mx-auto w-full max-w-5xl md:max-w-sm">
            <Button
              onClick={openSetup}
              disabled={!hasPermission}
              size="lg"
              data-testid="start-chat"
              className="w-full min-h-14 justify-center text-xl font-bold bg-yellow-400 text-black hover:bg-yellow-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t("start")}
            </Button>
            <p className="mt-1 text-xs text-gray-300 text-center" data-testid="rules-reminder">
              {!hasPermission && <span className="block">{t("camera.allowToContinue")}</span>}
              <Trans
                t={t}
                i18nKey="rules.reminder"
                components={{
                  guidelines: (
                    <Link
                      to="/guidelines"
                      className="inline-flex min-h-tap min-w-tap items-center justify-center px-1 underline text-yellow-300"
                    />
                  ),
                }}
              />
            </p>
          </div>
        </StickyBar>
      </div>

      <Footer />

      <ProfileEditor
        key={setupSession}
        open={setupOpen}
        onOpenChange={setSetupOpen}
        form={form}
        onFormChange={patchForm}
        stream={stream}
        cameraError={error}
        onRetryCamera={retryCamera}
        hasPermission={hasPermission}
        onSubmit={beginChat}
      />

      <StartSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        form={form}
        onFormChange={patchForm}
        preferences={preferences}
        onPreferencesChange={setPreferences}
        privateModeEnabled={privateModeEnabled}
        hideIp={startOptions.hideIp}
        onHideIpChange={startOptions.setHideIp}
      />
    </div>
  );
};
