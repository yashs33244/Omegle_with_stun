import React from "react";
import { Lock, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Select, SelectItem } from "@/components/retroui/Select";
import { GENDER_OPTIONS } from "@/lib/utils";
import { GENDER_FILTERS, type GenderFilter } from "@/lib/protocol";
import { useGenderFilterGate } from "@/premium";

interface GenderFilterPickerProps {
  /** Id of the trigger; the label gets `${id}-label`. */
  id: string;
  value: GenderFilter;
  /** Called with the new filter, only when the user may use it. */
  onChange: (value: GenderFilter) => void;
  disabled?: boolean;
  "data-testid"?: string;
}

const isGenderFilter = (v: string): v is GenderFilter => (GENDER_FILTERS as readonly string[]).includes(v);

/**
 * "Who do you want to meet?" Shared by the start-screen settings and the
 * in-call settings. The gender filter is a paid feature: while locked, the
 * label carries a lock badge and choosing anything but Everyone opens the
 * unlock sheet instead of saving (the server refuses it anyway).
 */
export const GenderFilterPicker: React.FC<GenderFilterPickerProps> = ({
  id,
  value,
  onChange,
  disabled,
  "data-testid": testId,
}) => {
  const { t } = useTranslation("room");
  const gate = useGenderFilterGate();
  const labelId = `${id}-label`;
  const locked = gate.enabled && !gate.unlocked;

  const handleChange = (next: string) => {
    if (!isGenderFilter(next) || next === value) return;
    if (next !== "all" && locked) {
      gate.openUnlockSheet();
      return;
    }
    onChange(next);
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Users className="w-4 h-4 text-blue-400 shrink-0" aria-hidden="true" />
        <label id={labelId} htmlFor={id} className="text-sm font-medium">
          {t("settings.genderLabel")}
        </label>
        {locked && (
          <button
            type="button"
            onClick={gate.openUnlockSheet}
            data-testid="gender-lock"
            className="ml-auto flex min-h-9 items-center gap-1 rounded-full border-2 border-black bg-yellow-400 px-2.5 text-xs font-bold text-black"
          >
            <Lock className="w-3.5 h-3.5" aria-hidden="true" />
            {t("settings.genderLocked")}
          </button>
        )}
      </div>
      <Select
        id={id}
        labelId={labelId}
        aria-label={t("settings.genderLabel")}
        data-testid={testId}
        value={value}
        onValueChange={handleChange}
        disabled={disabled}
      >
        {GENDER_OPTIONS.map((option) => (
          <SelectItem key={option} value={option}>
            {t(`settings.gender.${option}`)}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
};
