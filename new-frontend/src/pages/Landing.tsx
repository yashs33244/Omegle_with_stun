import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Camera, Languages, Loader, User } from "lucide-react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { useMediaStream, type MediaAccessError } from "../hooks/useMediaStream";
import { Room } from "./Room";
import { Footer } from "@/components/Footer";
import { trackOnce } from "@/lib/observability";
import { Button } from "@/components/retroui/Button";
import { Input } from "@/components/retroui/Input";
import { Select, SelectItem } from "@/components/retroui/Select";
import { closedASelect } from "@/components/retroui/selectDismissal";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { countries, getCountryByCode, getLanguageByCode, languages } from "../lib/data";
import { FLAG_DEFAULTS, LIMITS, TOPICS, type Gender, type MatchMode, type Preferences, type Topic } from "../lib/protocol";
import { MatchModeToggle } from "@/components/MatchModeToggle";
import { HideIpToggle } from "@/components/room/HideIpToggle";
import { InAppBrowserNotice } from "@/components/room/InAppBrowserNotice";
import { PreflightCheck } from "@/components/room/PreflightCheck";
import { useStartOptions } from "@/hooks/useStartOptions";
import { detectInAppBrowser, runningOnMobile } from "@/lib/mobile";
import { preloadModels } from "@/moderation/modelClient";
import { PhotoCaptureError, captureVideoFrame, type PhotoErrorReason } from "../lib/photo";
import { GENDER_CHOICES, TOPIC_EMOJI, hasErrors, toProfile, validateProfileForm, type ProfileForm } from "../lib/profileForm";

const isGender = (v: string): v is Gender => GENDER_CHOICES.some((g) => g.value === v);

/**
 * Callback ref that binds a MediaStream to whichever <video> is mounted right
 * now. A remounted element (back from a chat, Retake Photo) is rebound too.
 */
function useStreamVideo(stream: MediaStream | null) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    if (stream) {
      video.play().catch(() => {
        // Muted preview; a rejected play only means the element was replaced again.
      });
    }
  }, [video, stream]);
  return [setVideo, video] as const;
}

/** Keeps the dialog open when Escape is meant for an open dropdown inside it. */
function keepOpenWhileDropdownOpen(e: KeyboardEvent) {
  const target = e.target;
  if (target instanceof Element && target.closest('[aria-expanded="true"], [role="listbox"]')) {
    e.preventDefault();
  }
}

const CameraProblem: React.FC<{ error: MediaAccessError; onRetry: () => void; tone: "dark" | "light" }> = ({
  error,
  onRetry,
  tone,
}) => {
  const { t } = useTranslation(["landing", "room"]);
  return (
    <div role="alert" className="text-center space-y-3 px-4" data-testid="camera-error">
      <AlertTriangle className={`w-12 h-12 mx-auto ${tone === "dark" ? "text-yellow-400" : "text-red-500"}`} />
      <p className={`text-xl font-bold ${tone === "dark" ? "text-white" : "text-black"}`}>
        {t(`room:camera.${error.kind}.title`)}
      </p>
      <p className={`text-sm ${tone === "dark" ? "text-gray-300" : "text-gray-600"}`}>
        {t(`room:camera.${error.kind}.message`)}
      </p>
      <Button onClick={onRetry} className="mx-auto bg-yellow-500 text-black hover:bg-yellow-400">
        {t("landing:camera.tryAgain")}
      </Button>
    </div>
  );
};

export interface LandingProps {
  /** Server default for the match mode (GET /api/config defaultMode). */
  defaultMode?: MatchMode;
  /** Hide my IP is offered at all (GET /api/config privateModeEnabled). */
  privateModeEnabled?: boolean;
}

/** In-app browsers (Instagram, WhatsApp...) get the "open in your browser" notice first. */
export const Landing: React.FC<LandingProps> = (props) => {
  const [inAppApp, setInAppApp] = useState(() =>
    typeof navigator === "undefined" ? null : detectInAppBrowser(navigator.userAgent),
  );
  if (inAppApp) return <InAppBrowserNotice app={inAppApp} onContinue={() => setInAppApp(null)} />;
  return <LandingScreen {...props} />;
};

const LandingScreen: React.FC<LandingProps> = ({
  defaultMode = FLAG_DEFAULTS.default_mode,
  privateModeEnabled = FLAG_DEFAULTS.private_mode_enabled,
}) => {
  const { t } = useTranslation("landing");
  const [step, setStep] = useState<"home" | "chat">("home");
  const startOptions = useStartOptions(defaultMode);
  const [isPhone] = useState(runningOnMobile);

  // Download and compile the moderation models while the user sets up.
  useEffect(() => {
    preloadModels();
  }, []);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<"capture" | "details">("capture");
  const [form, setForm] = useState<ProfileForm>({
    name: "",
    country: "IN",
    language: "en",
    gender: "unspecified",
    topics: ["general"],
  });
  const [nameTouched, setNameTouched] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>({
    genderFilter: "all",
    languageFilter: "any",
  });
  const [captureError, setCaptureError] = useState<PhotoErrorReason | "unknown" | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const captureButtonRef = useRef<HTMLButtonElement>(null);

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

  const [homeVideoRef] = useStreamVideo(stream);
  const [modalVideoRef, modalVideo] = useStreamVideo(stream);

  // A new preview element or stream has no frame until it fires loadeddata.
  useEffect(() => {
    setPreviewReady(!!modalVideo && !!stream && modalVideo.readyState >= 2);
  }, [modalVideo, stream]);

  // Put focus where the current setup step starts (Radix keeps it inside the dialog).
  useEffect(() => {
    if (!setupOpen) return;
    const target = setupStep === "details" ? nameInputRef.current : captureButtonRef.current;
    target?.focus();
  }, [setupOpen, setupStep]);

  const errors = validateProfileForm(form);
  const profile = useMemo(() => toProfile(form), [form]);

  const retryCamera = useCallback(() => {
    void getCam();
  }, [getCam]);

  const openSetup = () => {
    setSetupStep(form.photo ? "details" : "capture");
    setCaptureError(null);
    setSetupOpen(true);
  };

  const capturePhoto = () => {
    if (!modalVideo) return;
    try {
      const photo = captureVideoFrame(modalVideo);
      setForm((prev) => ({ ...prev, photo }));
      setCaptureError(null);
      setSetupStep("details");
    } catch (err) {
      setCaptureError(err instanceof PhotoCaptureError ? err.reason : "unknown");
    }
  };

  // The current photo stays until a new capture succeeds or the user skips the photo.
  const retakePhoto = () => {
    setCaptureError(null);
    setSetupStep("capture");
  };

  const skipPhoto = () => {
    setForm((prev) => ({ ...prev, photo: undefined }));
    setSetupStep("details");
  };

  const beginChat = () => {
    if (hasErrors(errors) || !hasPermission) {
      setNameTouched(true);
      return;
    }
    setSetupOpen(false);
    setStep("chat");
  };

  // Release the camera with the call, then start a fresh one for the home screen.
  const leaveRoom = useCallback(() => {
    stopStream();
    setStep("home");
    void getCam();
  }, [stopStream, getCam]);

  const toggleTopic = (topic: Topic) => {
    setForm((prev) => ({
      ...prev,
      topics: prev.topics.includes(topic) ? prev.topics.filter((t) => t !== topic) : [...prev.topics, topic],
    }));
  };

  if (step === "chat") {
    return (
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
    );
  }

  const countryData = getCountryByCode(form.country);
  const languageData = getLanguageByCode(form.language);
  const showNameError = nameTouched && errors.name;

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Full-screen camera background */}
      <div className="absolute inset-0 z-0 bg-gray-900">
        {stream && (
          <video
            ref={homeVideoRef}
            autoPlay
            playsInline
            muted
            aria-hidden="true"
            className="w-full h-full object-cover"
            style={{ transform: "scaleX(-1)" }}
          />
        )}
      </div>

      {/* Overlay content */}
      <div className="relative z-10 min-h-screen bg-black bg-opacity-40 flex flex-col md:flex-row">
        {/* Left sidebar */}
        <div className="w-full md:w-80 bg-black bg-opacity-60 backdrop-blur-sm p-6 flex flex-col justify-between gap-6 text-white">
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-bold text-yellow-400">{t("appName", { ns: "common" })}</h1>
            </div>

            {/* Profile summary */}
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={openSetup}
                  aria-label={t("profile.editAria")}
                  className="w-12 h-12 shrink-0 rounded-full bg-yellow-500 flex items-center justify-center overflow-hidden hover:bg-yellow-400 transition-colors cursor-pointer"
                >
                  {form.photo ? (
                    <img src={form.photo} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <User className="w-6 h-6 text-black" aria-hidden="true" />
                  )}
                </button>
                <div className="min-w-0">
                  <p className="font-medium truncate">{form.name.trim() || t("profile.guest")}</p>
                  <div className="flex items-center gap-2 text-sm text-gray-300">
                    <span aria-hidden="true">{countryData?.flag}</span>
                    <span>{countryData && t(`countries.${countryData.code}`)}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm">
                <Languages className="w-4 h-4" aria-hidden="true" />
                <span>
                  {languageData && t("profile.speaks", { language: t(`languages.${languageData.code}`) })}
                </span>
              </div>

              <div className="space-y-2">
                <h2 className="font-medium text-sm">{t("profile.topicsHeading")}</h2>
                <div className="flex flex-wrap gap-2">
                  {form.topics.slice(0, 3).map((topic) => (
                    <div
                      key={topic}
                      className="px-2 py-1 bg-white bg-opacity-20 rounded-full text-xs flex items-center gap-1"
                    >
                      <span aria-hidden="true">{TOPIC_EMOJI[topic]}</span>
                      <span>{t(`topics.${topic}`)}</span>
                    </div>
                  ))}
                  {form.topics.length > 3 && (
                    <span className="px-2 py-1 text-xs text-gray-300">
                      {t("profile.more", { count: form.topics.length - 3 })}
                    </span>
                  )}
                </div>
                <button type="button" onClick={openSetup} className="text-yellow-400 text-xs hover:underline">
                  {t("profile.edit")}
                </button>
              </div>

              <div className="flex items-center gap-2 text-sm" role="status">
                <div
                  aria-hidden="true"
                  className={`w-2 h-2 rounded-full ${stream ? "bg-green-400" : "bg-red-400"}`}
                />
                <span>{stream ? t("camera.ready") : isLoading ? t("camera.starting") : t("camera.off")}</span>
              </div>

              {stream && <PreflightCheck stream={stream} />}
            </div>
          </div>

          {/* Settings */}
          <div className="space-y-3">
            <div className="space-y-2">
              <label id="home-language-label" htmlFor="home-language" className="text-xs text-gray-300 block">
                {t("settings.language")}
              </label>
              <Select
                id="home-language"
                labelId="home-language-label"
                aria-label={t("settings.language")}
                value={form.language}
                onValueChange={(language) => setForm((prev) => ({ ...prev, language }))}
              >
                {languages.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {t(`languages.${lang.code}`)}
                  </SelectItem>
                ))}
              </Select>
            </div>

            <div className="space-y-2">
              <label id="home-country-label" htmlFor="home-country" className="text-xs text-gray-300 block">
                {t("settings.country")}
              </label>
              <Select
                id="home-country"
                labelId="home-country-label"
                aria-label={t("settings.country")}
                value={form.country}
                onValueChange={(country) => setForm((prev) => ({ ...prev, country }))}
              >
                {countries.map((country) => (
                  <SelectItem key={country.code} value={country.code}>
                    {country.flag} {t(`countries.${country.code}`)}
                  </SelectItem>
                ))}
              </Select>
            </div>
          </div>
        </div>

        {/* Camera status and start button */}
        <div className="flex-1 flex flex-col items-center justify-between gap-8 px-4 pb-6 pt-10">
          <div className="flex-1 flex items-center justify-center">
            {!stream &&
              (isLoading ? (
                <div className="text-center text-white space-y-4" role="status">
                  <Loader className="w-12 h-12 animate-spin mx-auto" aria-hidden="true" />
                  <p>{t("camera.startingYours")}</p>
                </div>
              ) : error ? (
                <CameraProblem error={error} onRetry={retryCamera} tone="dark" />
              ) : (
                <div className="text-center text-white space-y-4">
                  <Camera className="w-16 h-16 mx-auto text-gray-400" aria-hidden="true" />
                  <p className="text-xl">{t("camera.required")}</p>
                  <Button onClick={retryCamera} className="mx-auto bg-yellow-500 text-black hover:bg-yellow-400">
                    {t("camera.enable")}
                  </Button>
                </div>
              ))}
          </div>
          <div className="text-center space-y-4 flex flex-col items-center">
            <MatchModeToggle mode={startOptions.mode} onChange={startOptions.setMode} />
            {privateModeEnabled && (
              <div className="text-left text-white bg-black bg-opacity-60 rounded-lg p-3 max-w-sm">
                <HideIpToggle checked={startOptions.hideIp} onChange={startOptions.setHideIp} />
              </div>
            )}
            <Button
              onClick={openSetup}
              disabled={!hasPermission}
              size="lg"
              data-testid="start-chat"
              className="px-16 py-4 text-xl font-bold bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed border-2 border-black shadow-lg"
            >
              {t("start")}
            </Button>
            {!hasPermission && <p className="text-white text-sm">{t("camera.allowToContinue")}</p>}
            <p className="text-white text-xs max-w-sm mx-auto" data-testid="rules-reminder">
              <Trans
                t={t}
                i18nKey="rules.reminder"
                components={{ guidelines: <Link to="/guidelines" className="underline text-yellow-300" /> }}
              />
            </p>
          </div>
          <Footer />
        </div>
      </div>

      {/* Profile setup */}
      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent
          className="max-w-md w-[calc(100%-2rem)] bg-white text-black rounded-lg max-h-[90vh] overflow-y-auto"
          onEscapeKeyDown={keepOpenWhileDropdownOpen}
          onPointerDownOutside={(e) => {
            // Like Escape: a press outside while a dropdown is open closes only the dropdown.
            if (closedASelect(e.detail.originalEvent)) e.preventDefault();
          }}
        >
          <div className="space-y-6">
            <div className="text-center">
              <DialogTitle className="text-xl font-bold text-black">
                {setupStep === "capture" ? t("setup.captureTitle") : t("setup.detailsTitle")}
              </DialogTitle>
              <DialogDescription className="text-gray-600 mt-2">
                {setupStep === "capture" ? t("setup.captureDescription") : t("setup.detailsDescription")}
              </DialogDescription>
            </div>

            {setupStep === "capture" ? (
              <div className="space-y-6">
                <div className="relative">
                  <video
                    ref={modalVideoRef}
                    autoPlay
                    playsInline
                    muted
                    aria-label={t("setup.previewAria")}
                    onLoadedData={() => setPreviewReady(true)}
                    className="w-full aspect-video rounded-lg object-cover bg-gray-900"
                    style={{ transform: "scaleX(-1)" }}
                  />
                  <div className="absolute inset-0 border-2 border-yellow-500 rounded-lg pointer-events-none" />
                  <div className="absolute top-2 right-2 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs">
                    {previewReady ? (
                      <span className="text-green-400">{t("setup.previewReady")}</span>
                    ) : (
                      <span className="text-red-400">{t("setup.previewLoading")}</span>
                    )}
                  </div>
                </div>

                {!stream && error ? (
                  <CameraProblem error={error} onRetry={retryCamera} tone="light" />
                ) : (
                  <div className="text-center space-y-4">
                    <p className="text-sm text-gray-600">{t("setup.positionFace")}</p>
                    <Button
                      ref={captureButtonRef}
                      onClick={capturePhoto}
                      disabled={!previewReady}
                      data-testid="capture-photo"
                      className="w-full justify-center bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50"
                    >
                      {t("setup.capture")}
                    </Button>
                    {captureError && (
                      <p role="alert" className="text-sm text-red-600">
                        {t(`photo.${captureError}`)}
                      </p>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={skipPhoto}
                  data-testid="skip-photo"
                  className="w-full text-sm text-gray-600 underline hover:text-black"
                >
                  {t("setup.skip")}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-col items-center space-y-3">
                  {form.photo ? (
                    <img
                      src={form.photo}
                      alt={t("setup.photoAlt")}
                      className="w-20 h-20 rounded-full object-cover border-2 border-yellow-500"
                    />
                  ) : (
                    <div className="w-20 h-20 rounded-full bg-gray-200 flex items-center justify-center border-2 border-gray-300">
                      <User className="w-8 h-8 text-gray-500" aria-hidden="true" />
                    </div>
                  )}
                  <Button
                    onClick={retakePhoto}
                    variant="outline"
                    size="sm"
                    className="text-xs border-gray-400 text-gray-600 hover:bg-gray-50"
                  >
                    {form.photo ? t("setup.retake") : t("setup.take")}
                  </Button>
                </div>

                <div className="space-y-2">
                  <label htmlFor="profile-name" className="text-sm font-medium text-black block">
                    {t("form.nameLabel")}
                  </label>
                  <Input
                    ref={nameInputRef}
                    id="profile-name"
                    type="text"
                    placeholder={t("form.namePlaceholder")}
                    autoComplete="nickname"
                    data-testid="name-input"
                    value={form.name}
                    maxLength={LIMITS.nameMax}
                    aria-invalid={showNameError ? true : undefined}
                    aria-describedby={showNameError ? "profile-name-error" : undefined}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    onBlur={() => setNameTouched(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        beginChat();
                      }
                    }}
                    className="border-gray-300 text-black"
                  />
                  {/* Always rendered with a reserved line, so showing the error on blur does not
                      move the controls below while a click on one of them is in progress. */}
                  <p id="profile-name-error" className="min-h-4 text-xs text-red-600">
                    {showNameError ? t(showNameError) : null}
                  </p>
                </div>

                <div className="space-y-2">
                  <label id="profile-gender-label" htmlFor="profile-gender" className="text-sm font-medium text-black block">
                    {t("form.genderLabel")}
                  </label>
                  <Select
                    id="profile-gender"
                    labelId="profile-gender-label"
                    aria-label={t("form.genderLabel")}
                    data-testid="gender-select"
                    value={form.gender}
                    onValueChange={(gender) => {
                      if (isGender(gender)) setForm((prev) => ({ ...prev, gender }));
                    }}
                  >
                    {GENDER_CHOICES.map((g) => (
                      <SelectItem key={g.value} value={g.value}>
                        {t(g.label)}
                      </SelectItem>
                    ))}
                  </Select>
                  <p className="text-xs text-gray-500">{t("form.genderHint")}</p>
                </div>

                <fieldset className="space-y-2" aria-describedby={errors.topics ? "profile-topics-error" : undefined}>
                  <legend className="text-sm font-medium text-black">{t("form.topicsLegend")}</legend>
                  <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                    {TOPICS.map((topic) => {
                      const selected = form.topics.includes(topic);
                      return (
                        <button
                          type="button"
                          key={topic}
                          onClick={() => toggleTopic(topic)}
                          aria-pressed={selected}
                          data-testid={`topic-${topic}`}
                          className={`p-2 text-left text-sm border-2 rounded-lg transition-all text-black ${
                            selected ? "border-yellow-500 bg-yellow-50" : "border-gray-300 hover:border-gray-400"
                          }`}
                        >
                          <span className="mr-2" aria-hidden="true">
                            {TOPIC_EMOJI[topic]}
                          </span>
                          {t(`topics.${topic}`)}
                        </button>
                      );
                    })}
                  </div>
                  {errors.topics && (
                    <p id="profile-topics-error" className="text-xs text-red-600">
                      {t(errors.topics)}
                    </p>
                  )}
                </fieldset>

                {!hasPermission && (
                  <p role="alert" className="text-xs text-red-600">
                    {t("form.cameraNotReady")}
                  </p>
                )}

                <Button
                  onClick={beginChat}
                  disabled={hasErrors(errors) || !hasPermission}
                  data-testid="begin-chat"
                  className="w-full justify-center bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t("form.submit")}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
