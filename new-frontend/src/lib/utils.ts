import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Gender filter options for random chat; labels are `room:settings.gender.<value>`
export const GENDER_OPTIONS = ['all', 'male', 'female', 'other'] as const;

// Language options for international chat; labels are `room:settings.languages.<value>`
export const LANGUAGE_OPTIONS = [
  { value: 'en', flag: '🇺🇸' },
  { value: 'es', flag: '🇪🇸' },
  { value: 'fr', flag: '🇫🇷' },
  { value: 'de', flag: '🇩🇪' },
  { value: 'it', flag: '🇮🇹' },
  { value: 'pt', flag: '🇵🇹' },
  { value: 'ru', flag: '🇷🇺' },
  { value: 'zh', flag: '🇨🇳' },
  { value: 'ja', flag: '🇯🇵' },
  { value: 'ko', flag: '🇰🇷' },
  { value: 'ar', flag: '🇸🇦' },
  { value: 'hi', flag: '🇮🇳' }
] as const;

// Connection quality indicators
export const CONNECTION_QUALITY = {
  EXCELLENT: { color: 'text-green-400', bar: 'bg-green-400', bars: 4 },
  GOOD: { color: 'text-yellow-400', bar: 'bg-yellow-400', bars: 3 },
  FAIR: { color: 'text-orange-400', bar: 'bg-orange-400', bars: 2 },
  POOR: { color: 'text-red-400', bar: 'bg-red-400', bars: 1 },
  DISCONNECTED: { color: 'text-red-400', bar: 'bg-red-400', bars: 0 }
} as const;

/** A translator for topic names: any `t` from useTranslation (the landing namespace holds them). */
type TopicTranslator = (key: string, options: { defaultValue: string }) => string;

// Topic ids as names in the UI language: ["music", "art"] -> "Music, Art & Design" (or the Hindi names).
export function formatTopics(t: TopicTranslator, topics: readonly string[]): string {
  return topics
    .map((topic) => t(`landing:topics.${topic}`, { defaultValue: topic.charAt(0).toUpperCase() + topic.slice(1) }))
    .join(', ');
}

// Format connection time for display
export function formatConnectionTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}
