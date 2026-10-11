import { LIMITS, TOPICS, type Gender, type Profile, type Topic } from "./protocol";
import { isAcceptablePhoto } from "./photo";

export interface ProfileForm {
  name: string;
  country: string;
  language: string;
  gender: Gender;
  topics: Topic[];
  photo?: string;
}

export type ProfileFormErrorKey = "form.errors.nameRequired" | "form.errors.topicsRequired";

export interface ProfileFormErrors {
  name?: ProfileFormErrorKey;
  topics?: ProfileFormErrorKey;
}

/** Labels are landing-namespace keys, translated where they render. */
export const GENDER_CHOICES = [
  { value: "male", label: "form.gender.male" },
  { value: "female", label: "form.gender.female" },
  { value: "other", label: "form.gender.other" },
  { value: "unspecified", label: "form.gender.unspecified" },
] as const satisfies ReadonlyArray<{ value: Gender; label: `form.gender.${Gender}` }>;

export const TOPIC_EMOJI: Record<Topic, string> = {
  general: "💬",
  gaming: "🎮",
  music: "🎵",
  movies: "🎬",
  sports: "⚽",
  technology: "💻",
  art: "🎨",
  travel: "✈️",
  food: "🍕",
  books: "📚",
};

export const isTopic = (id: string): id is Topic => (TOPICS as readonly string[]).includes(id);

export function validateProfileForm(form: Pick<ProfileForm, "name" | "topics">): ProfileFormErrors {
  const errors: ProfileFormErrors = {};
  if (form.name.trim().length === 0) errors.name = "form.errors.nameRequired";
  if (form.topics.length === 0) errors.topics = "form.errors.topicsRequired";
  return errors;
}

export const hasErrors = (errors: ProfileFormErrors): boolean => Object.keys(errors).length > 0;

/** The profile sent in session:hello. Photos the server would reject are left out. */
export function toProfile(form: ProfileForm): Profile {
  const photo = form.photo && isAcceptablePhoto(form.photo) ? form.photo : undefined;
  return {
    name: form.name.trim().slice(0, LIMITS.nameMax),
    country: form.country,
    language: form.language,
    gender: form.gender,
    topics: form.topics.slice(0, LIMITS.topicsMax),
    ...(photo ? { photo } : {}),
  };
}
