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

export interface ProfileFormErrors {
  name?: string;
  topics?: string;
}

export const GENDER_CHOICES: ReadonlyArray<{ value: Gender; label: string }> = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "other", label: "Other" },
  { value: "unspecified", label: "Prefer not to say" },
];

export const TOPIC_LABELS: Record<Topic, { name: string; emoji: string }> = {
  general: { name: "General Chat", emoji: "💬" },
  gaming: { name: "Gaming", emoji: "🎮" },
  music: { name: "Music", emoji: "🎵" },
  movies: { name: "Movies", emoji: "🎬" },
  sports: { name: "Sports", emoji: "⚽" },
  technology: { name: "Technology", emoji: "💻" },
  art: { name: "Art & Design", emoji: "🎨" },
  travel: { name: "Travel", emoji: "✈️" },
  food: { name: "Food", emoji: "🍕" },
  books: { name: "Books", emoji: "📚" },
};

export const isTopic = (id: string): id is Topic => (TOPICS as readonly string[]).includes(id);

export function validateProfileForm(form: Pick<ProfileForm, "name" | "topics">): ProfileFormErrors {
  const errors: ProfileFormErrors = {};
  if (form.name.trim().length === 0) errors.name = "Enter your name.";
  if (form.topics.length === 0) errors.topics = "Choose at least one topic.";
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
