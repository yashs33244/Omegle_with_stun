import React, { useEffect, useRef, useState } from "react";
import { Camera, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/retroui/Button";
import { Input } from "@/components/retroui/Input";
import { Select, SelectItem } from "@/components/retroui/Select";
import { keepOpenWhenSelectClosed, keepOpenWhileDropdownOpen } from "@/components/retroui/selectDismissal";
import { BottomSheet } from "@/components/ui/BottomSheet";
import type { MediaAccessError } from "@/hooks/useMediaStream";
import { useStreamVideo } from "@/hooks/useStreamVideo";
import { PhotoCaptureError, captureVideoFrame, type PhotoErrorReason } from "@/lib/photo";
import {
  GENDER_CHOICES,
  TOPIC_EMOJI,
  hasErrors,
  validateProfileForm,
  type ProfileForm,
} from "@/lib/profileForm";
import { LIMITS, TOPICS, type Gender, type Topic } from "@/lib/protocol";
import { CameraProblem } from "./CameraProblem";

const isGender = (v: string): v is Gender => GENDER_CHOICES.some((g) => g.value === v);

export interface ProfileEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: ProfileForm;
  onFormChange: (patch: Partial<ProfileForm>) => void;
  stream: MediaStream | null;
  cameraError: MediaAccessError | null;
  onRetryCamera: () => void;
  hasPermission: boolean;
  /** The form is valid and the camera is ready: start the chat. */
  onSubmit: () => void;
}

/**
 * Photo, name, gender and topics, in two steps: take a photo (or skip), then
 * the details. A bottom sheet on phones, a dialog on desktop; the primary
 * button sits in the sheet footer. Remount (change the `key`) to start over at
 * the right step: capture without a photo, details with one.
 */
export const ProfileEditor: React.FC<ProfileEditorProps> = ({
  open,
  onOpenChange,
  form,
  onFormChange,
  stream,
  cameraError,
  onRetryCamera,
  hasPermission,
  onSubmit,
}) => {
  const { t } = useTranslation("landing");
  const [step, setStep] = useState<"capture" | "details">(form.photo ? "details" : "capture");
  const [captureError, setCaptureError] = useState<PhotoErrorReason | "unknown" | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const captureButtonRef = useRef<HTMLButtonElement>(null);
  const [videoRef, video] = useStreamVideo(stream);

  // A new preview element or stream has no frame until it fires loadeddata.
  useEffect(() => {
    setPreviewReady(!!video && !!stream && video.readyState >= 2);
  }, [video, stream]);

  // Put focus where the current step starts (Radix keeps it inside the sheet).
  useEffect(() => {
    if (!open) return;
    const target = step === "details" ? nameInputRef.current : captureButtonRef.current;
    target?.focus();
  }, [open, step]);

  const errors = validateProfileForm(form);
  const showNameError = nameTouched && errors.name;
  const canSubmit = !hasErrors(errors) && hasPermission;

  const capturePhoto = () => {
    if (!video) return;
    try {
      onFormChange({ photo: captureVideoFrame(video) });
      setCaptureError(null);
      setStep("details");
    } catch (err) {
      setCaptureError(err instanceof PhotoCaptureError ? err.reason : "unknown");
    }
  };

  // The current photo stays until a new capture succeeds or the user skips the photo.
  const retakePhoto = () => {
    setCaptureError(null);
    setStep("capture");
  };

  const skipPhoto = () => {
    onFormChange({ photo: undefined });
    setStep("details");
  };

  const submit = () => {
    if (!canSubmit) {
      setNameTouched(true);
      return;
    }
    onSubmit();
  };

  const toggleTopic = (topic: Topic) => {
    onFormChange({
      topics: form.topics.includes(topic) ? form.topics.filter((item) => item !== topic) : [...form.topics, topic],
    });
  };

  const footer =
    step === "capture" ? (
      <div className="space-y-2">
        <Button
          ref={captureButtonRef}
          onClick={capturePhoto}
          disabled={!previewReady || (!stream && !!cameraError)}
          data-testid="capture-photo"
          className="w-full min-h-tap justify-center bg-yellow-400 text-black hover:bg-yellow-300 disabled:opacity-50"
        >
          {t("setup.capture")}
        </Button>
        <button
          type="button"
          onClick={skipPhoto}
          data-testid="skip-photo"
          className="w-full min-h-tap text-sm text-gray-300 underline hover:text-white"
        >
          {t("setup.skip")}
        </button>
      </div>
    ) : (
      <div className="space-y-2">
        {!hasPermission && (
          <p role="alert" className="text-xs text-red-400">
            {t("form.cameraNotReady")}
          </p>
        )}
        <Button
          onClick={submit}
          disabled={!canSubmit}
          data-testid="begin-chat"
          className="w-full min-h-tap justify-center text-lg bg-yellow-400 text-black hover:bg-yellow-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t("form.submit")}
        </Button>
      </div>
    );

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={step === "capture" ? t("setup.captureTitle") : t("setup.detailsTitle")}
      description={step === "capture" ? t("setup.captureDescription") : t("setup.detailsDescription")}
      data-testid="profile-editor"
      onEscapeKeyDown={keepOpenWhileDropdownOpen}
      onPointerDownOutside={keepOpenWhenSelectClosed}
      footer={footer}
    >
      {step === "capture" ? (
        <div className="space-y-3">
          <div className="relative">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              aria-label={t("setup.previewAria")}
              onLoadedData={() => setPreviewReady(true)}
              className="w-full aspect-video rounded-xl object-cover bg-black"
              style={{ transform: "scaleX(-1)" }}
            />
            <div className="absolute inset-0 border-2 border-yellow-400 rounded-xl pointer-events-none" />
            <div className="absolute top-2 right-2 bg-black/70 text-white px-2 py-1 rounded text-xs">
              {previewReady ? (
                <span className="text-green-400">{t("setup.previewReady")}</span>
              ) : (
                <span className="text-red-400">{t("setup.previewLoading")}</span>
              )}
            </div>
          </div>
          {!stream && cameraError ? (
            <CameraProblem error={cameraError} onRetry={onRetryCamera} />
          ) : (
            <p className="text-sm text-gray-300 text-center">{t("setup.positionFace")}</p>
          )}
          {captureError && (
            <p role="alert" className="text-sm text-red-400 text-center">
              {t(`photo.${captureError}`)}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {form.photo ? (
              <img
                src={form.photo}
                alt={t("setup.photoAlt")}
                className="w-16 h-16 rounded-full object-cover border-2 border-yellow-400"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-gray-700 flex items-center justify-center border-2 border-gray-600">
                <User className="w-7 h-7 text-gray-300" aria-hidden="true" />
              </div>
            )}
            <button
              type="button"
              onClick={retakePhoto}
              className="flex min-h-tap items-center gap-1.5 rounded-full border-2 border-black bg-white px-4 text-sm font-bold text-black shadow-[0_3px_0_#000] hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
            >
              <Camera className="h-4 w-4" aria-hidden="true" />
              {form.photo ? t("setup.retake") : t("setup.take")}
            </button>
          </div>

          <div className="space-y-1">
            <label htmlFor="profile-name" className="text-sm font-medium block">
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
              onChange={(e) => onFormChange({ name: e.target.value })}
              onBlur={() => setNameTouched(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="min-h-tap rounded-lg border-black bg-white text-black"
            />
            {/* Always rendered with a reserved line, so showing the error on blur does not
                move the controls below while a click on one of them is in progress. */}
            <p id="profile-name-error" className="min-h-4 text-xs text-red-400">
              {showNameError ? t(showNameError) : null}
            </p>
          </div>

          <div className="space-y-1">
            <label id="profile-gender-label" htmlFor="profile-gender" className="text-sm font-medium block">
              {t("form.genderLabel")}
            </label>
            <Select
              id="profile-gender"
              labelId="profile-gender-label"
              aria-label={t("form.genderLabel")}
              data-testid="gender-select"
              value={form.gender}
              onValueChange={(gender) => {
                if (isGender(gender)) onFormChange({ gender });
              }}
            >
              {GENDER_CHOICES.map((g) => (
                <SelectItem key={g.value} value={g.value}>
                  {t(g.label)}
                </SelectItem>
              ))}
            </Select>
            <p className="text-xs text-gray-400">{t("form.genderHint")}</p>
          </div>

          <fieldset className="space-y-2" aria-describedby={errors.topics ? "profile-topics-error" : undefined}>
            <legend className="text-sm font-medium mb-2">{t("form.topicsLegend")}</legend>
            <div className="grid grid-cols-2 gap-2">
              {TOPICS.map((topic) => {
                const selected = form.topics.includes(topic);
                return (
                  <button
                    type="button"
                    key={topic}
                    onClick={() => toggleTopic(topic)}
                    aria-pressed={selected}
                    data-testid={`topic-${topic}`}
                    className={`flex min-h-10 items-center gap-2 px-3 text-left text-sm border-2 rounded-xl transition-colors ${
                      selected
                        ? "border-yellow-400 bg-yellow-400 text-black font-bold"
                        : "border-gray-600 text-white hover:border-gray-400"
                    }`}
                  >
                    <span aria-hidden="true">{TOPIC_EMOJI[topic]}</span>
                    <span className="truncate">{t(`topics.${topic}`)}</span>
                  </button>
                );
              })}
            </div>
            {errors.topics && (
              <p id="profile-topics-error" className="text-xs text-red-400">
                {t(errors.topics)}
              </p>
            )}
          </fieldset>
        </div>
      )}
    </BottomSheet>
  );
};
