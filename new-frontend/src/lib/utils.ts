import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { ReportReason } from "./protocol"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Gender filter options for random chat
export const GENDER_OPTIONS = [
  { value: 'all', label: 'Everyone' },
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' }
] as const;

// Language options for international chat
export const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English', flag: '🇺🇸' },
  { value: 'es', label: 'Spanish', flag: '🇪🇸' },
  { value: 'fr', label: 'French', flag: '🇫🇷' },
  { value: 'de', label: 'German', flag: '🇩🇪' },
  { value: 'it', label: 'Italian', flag: '🇮🇹' },
  { value: 'pt', label: 'Portuguese', flag: '🇵🇹' },
  { value: 'ru', label: 'Russian', flag: '🇷🇺' },
  { value: 'zh', label: 'Chinese', flag: '🇨🇳' },
  { value: 'ja', label: 'Japanese', flag: '🇯🇵' },
  { value: 'ko', label: 'Korean', flag: '🇰🇷' },
  { value: 'ar', label: 'Arabic', flag: '🇸🇦' },
  { value: 'hi', label: 'Hindi', flag: '🇮🇳' }
] as const;

// Human labels for the protocol report reasons
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  inappropriate: 'Inappropriate behavior',
  spam: 'Spam or unwanted content',
  nudity: 'Nudity or sexual content',
  harassment: 'Harassment or bullying',
  hate: 'Hate speech',
  violence: 'Violence or threats',
  fake: 'Fake profile',
  underage: 'Underage user',
  other: 'Other'
};

// Connection quality indicators
export const CONNECTION_QUALITY = {
  EXCELLENT: { color: 'text-green-400', bar: 'bg-green-400', bars: 4 },
  GOOD: { color: 'text-yellow-400', bar: 'bg-yellow-400', bars: 3 },
  FAIR: { color: 'text-orange-400', bar: 'bg-orange-400', bars: 2 },
  POOR: { color: 'text-red-400', bar: 'bg-red-400', bars: 1 },
  DISCONNECTED: { color: 'text-red-400', bar: 'bg-red-400', bars: 0 }
} as const;

// "music, art" -> "Music, Art"
export function formatTopics(topics: readonly string[]): string {
  return topics.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(', ');
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
