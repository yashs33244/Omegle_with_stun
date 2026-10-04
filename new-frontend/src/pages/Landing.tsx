import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Camera, Languages, Loader, User } from "lucide-react";
import { useMediaStream, type MediaAccessError } from "../hooks/useMediaStream";
import { Room } from "./Room";
import { Button } from "@/components/retroui/Button";
import { Input } from "@/components/retroui/Input";
import { Select, SelectItem } from "@/components/retroui/Select";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { countries, getCountryByCode, getLanguageByCode, languages } from "../lib/data";
import { LIMITS, TOPICS, type Gender, type Preferences, type Topic } from "../lib/protocol";
import { PhotoCaptureError, captureVideoFrame } from "../lib/photo";
import {
  GENDER_CHOICES,
  TOPIC_LABELS,
  hasErrors,
  toProfile,
  validateProfileForm,
  type ProfileForm,
} from "../lib/profileForm";

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
}) => (
  <div role="alert" className="text-center space-y-3 px-4" data-testid="camera-error">
    <AlertTriangle className={`w-12 h-12 mx-auto ${tone === "dark" ? "text-yellow-400" : "text-red-500"}`} />
    <p className={`text-xl font-bold ${tone === "dark" ? "text-white" : "text-black"}`}>{error.title}</p>
    <p className={`text-sm ${tone === "dark" ? "text-gray-300" : "text-gray-600"}`}>{error.message}</p>
    <Button onClick={onRetry} className="mx-auto bg-yellow-500 text-black hover:bg-yellow-400">
      Try again
    </Button>
  </div>
);

export const Landing = () => {
  const [step, setStep] = useState<"home" | "chat">("home");
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
  const [captureError, setCaptureError] = useState<string | null>(null);
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
  } = useMediaStream();

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
      setCaptureError(
        err instanceof PhotoCaptureError ? err.message : "Could not take the photo. Please try again.",
      );
    }
  };

  const retakePhoto = () => {
    setForm((prev) => ({ ...prev, photo: undefined }));
    setCaptureError(null);
    setSetupStep("capture");
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
              <h1 className="text-3xl font-bold text-yellow-400">Chizzy</h1>
            </div>

            {/* Profile summary */}
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={openSetup}
                  aria-label="Edit profile photo and details"
                  className="w-12 h-12 shrink-0 rounded-full bg-yellow-500 flex items-center justify-center overflow-hidden hover:bg-yellow-400 transition-colors cursor-pointer"
                >
                  {form.photo ? (
                    <img src={form.photo} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <User className="w-6 h-6 text-black" aria-hidden="true" />
                  )}
                </button>
                <div className="min-w-0">
                  <p className="font-medium truncate">{form.name.trim() || "Guest User"}</p>
                  <div className="flex items-center gap-2 text-sm text-gray-300">
                    <span aria-hidden="true">{countryData?.flag}</span>
                    <span>{countryData?.name}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm">
                <Languages className="w-4 h-4" aria-hidden="true" />
                <span>I speak: {languageData?.name}</span>
              </div>

              <div className="space-y-2">
                <h2 className="font-medium text-sm">My topics:</h2>
                <div className="flex flex-wrap gap-2">
                  {form.topics.slice(0, 3).map((topic) => (
                    <div
                      key={topic}
                      className="px-2 py-1 bg-white bg-opacity-20 rounded-full text-xs flex items-center gap-1"
                    >
                      <span aria-hidden="true">{TOPIC_LABELS[topic].emoji}</span>
                      <span>{TOPIC_LABELS[topic].name}</span>
                    </div>
                  ))}
                  {form.topics.length > 3 && (
                    <span className="px-2 py-1 text-xs text-gray-300">+{form.topics.length - 3} more</span>
                  )}
                </div>
                <button type="button" onClick={openSetup} className="text-yellow-400 text-xs hover:underline">
                  Edit profile
                </button>
              </div>

              <div className="flex items-center gap-2 text-sm" role="status">
                <div
                  aria-hidden="true"
                  className={`w-2 h-2 rounded-full ${stream ? "bg-green-400" : "bg-red-400"}`}
                />
                <span>{stream ? "Camera ready" : isLoading ? "Starting camera..." : "Camera off"}</span>
              </div>
            </div>
          </div>

          {/* Settings */}
          <div className="space-y-3">
            <div className="space-y-2">
              <label htmlFor="home-language" className="text-xs text-gray-300 block">
                Language
              </label>
              <Select
                id="home-language"
                aria-label="Language"
                value={form.language}
                onValueChange={(language) => setForm((prev) => ({ ...prev, language }))}
              >
                {languages.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.name}
                  </SelectItem>
                ))}
              </Select>
            </div>

            <div className="space-y-2">
              <label htmlFor="home-country" className="text-xs text-gray-300 block">
                Country
              </label>
              <Select
                id="home-country"
                aria-label="Country"
                value={form.country}
                onValueChange={(country) => setForm((prev) => ({ ...prev, country }))}
              >
                {countries.map((country) => (
                  <SelectItem key={country.code} value={country.code}>
                    {country.flag} {country.name}
                  </SelectItem>
                ))}
              </Select>
            </div>
          </div>
        </div>

        {/* Camera status and start button */}
        <div className="flex-1 flex flex-col items-center justify-between gap-8 px-4 pb-20 pt-10">
          <div className="flex-1 flex items-center justify-center">
            {!stream &&
              (isLoading ? (
                <div className="text-center text-white space-y-4" role="status">
                  <Loader className="w-12 h-12 animate-spin mx-auto" aria-hidden="true" />
                  <p>Starting your camera...</p>
                </div>
              ) : error ? (
                <CameraProblem error={error} onRetry={retryCamera} tone="dark" />
              ) : (
                <div className="text-center text-white space-y-4">
                  <Camera className="w-16 h-16 mx-auto text-gray-400" aria-hidden="true" />
                  <p className="text-xl">Camera access required</p>
                  <Button onClick={retryCamera} className="mx-auto bg-yellow-500 text-black hover:bg-yellow-400">
                    Enable Camera
                  </Button>
                </div>
              ))}
          </div>
          <div className="text-center space-y-4">
            <Button
              onClick={openSetup}
              disabled={!hasPermission}
              size="lg"
              data-testid="start-chat"
              className="px-16 py-4 text-xl font-bold bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed border-2 border-black shadow-lg"
            >
              Start
            </Button>
            {!hasPermission && <p className="text-white text-sm">Please allow camera access to continue</p>}
          </div>
        </div>
      </div>

      {/* Profile setup */}
      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent
          className="max-w-md w-[calc(100%-2rem)] bg-white text-black rounded-lg max-h-[90vh] overflow-y-auto"
          onEscapeKeyDown={keepOpenWhileDropdownOpen}
        >
          <div className="space-y-6">
            <div className="text-center">
              <DialogTitle className="text-xl font-bold text-black">
                {setupStep === "capture" ? "Capture Your Photo" : "Complete Profile"}
              </DialogTitle>
              <DialogDescription className="text-gray-600 mt-2">
                {setupStep === "capture"
                  ? "Take a real-time photo for your profile"
                  : "Enter your details and select topics"}
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
                    aria-label="Camera preview"
                    onLoadedData={() => setPreviewReady(true)}
                    className="w-full aspect-video rounded-lg object-cover bg-gray-900"
                    style={{ transform: "scaleX(-1)" }}
                  />
                  <div className="absolute inset-0 border-2 border-yellow-500 rounded-lg pointer-events-none" />
                  <div className="absolute top-2 right-2 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs">
                    {previewReady ? (
                      <span className="text-green-400">● Ready</span>
                    ) : (
                      <span className="text-red-400">● Loading...</span>
                    )}
                  </div>
                </div>

                {!stream && error ? (
                  <CameraProblem error={error} onRetry={retryCamera} tone="light" />
                ) : (
                  <div className="text-center space-y-4">
                    <p className="text-sm text-gray-600">Position your face in the frame and click capture</p>
                    <Button
                      ref={captureButtonRef}
                      onClick={capturePhoto}
                      disabled={!previewReady}
                      data-testid="capture-photo"
                      className="w-full justify-center bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50"
                    >
                      Capture Photo
                    </Button>
                    {captureError && (
                      <p role="alert" className="text-sm text-red-600">
                        {captureError}
                      </p>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setSetupStep("details")}
                  data-testid="skip-photo"
                  className="w-full text-sm text-gray-600 underline hover:text-black"
                >
                  Continue without a photo
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-col items-center space-y-3">
                  {form.photo ? (
                    <img
                      src={form.photo}
                      alt="Your profile photo"
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
                    {form.photo ? "Retake Photo" : "Take a Photo"}
                  </Button>
                </div>

                <div className="space-y-2">
                  <label htmlFor="profile-name" className="text-sm font-medium text-black block">
                    Your Name
                  </label>
                  <Input
                    ref={nameInputRef}
                    id="profile-name"
                    type="text"
                    placeholder="Enter your name"
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
                  {showNameError && (
                    <p id="profile-name-error" className="text-xs text-red-600">
                      {errors.name}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <label htmlFor="profile-gender" className="text-sm font-medium text-black block">
                    Gender
                  </label>
                  <Select
                    id="profile-gender"
                    aria-label="Gender"
                    data-testid="gender-select"
                    value={form.gender}
                    onValueChange={(gender) => {
                      if (isGender(gender)) setForm((prev) => ({ ...prev, gender }));
                    }}
                  >
                    {GENDER_CHOICES.map((g) => (
                      <SelectItem key={g.value} value={g.value}>
                        {g.label}
                      </SelectItem>
                    ))}
                  </Select>
                  <p className="text-xs text-gray-500">Only used for matching filters. It is never shown to anyone.</p>
                </div>

                <fieldset className="space-y-2" aria-describedby={errors.topics ? "profile-topics-error" : undefined}>
                  <legend className="text-sm font-medium text-black">Select Topics (Choose at least one)</legend>
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
                            {TOPIC_LABELS[topic].emoji}
                          </span>
                          {TOPIC_LABELS[topic].name}
                        </button>
                      );
                    })}
                  </div>
                  {errors.topics && (
                    <p id="profile-topics-error" className="text-xs text-red-600">
                      {errors.topics}
                    </p>
                  )}
                </fieldset>

                {!hasPermission && (
                  <p role="alert" className="text-xs text-red-600">
                    Your camera is not ready yet. Close this window and allow camera access.
                  </p>
                )}

                <Button
                  onClick={beginChat}
                  disabled={hasErrors(errors) || !hasPermission}
                  data-testid="begin-chat"
                  className="w-full justify-center bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Start Chatting
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
