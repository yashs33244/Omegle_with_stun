import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

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

// Report reasons for user reporting
export const REPORT_REASONS = [
  'Inappropriate behavior',
  'Spam or unwanted content',
  'Nudity or sexual content',
  'Harassment or bullying',
  'Hate speech',
  'Violence or threats',
  'Fake profile',
  'Underage user',
  'Other'
] as const;

// Connection quality indicators
export const CONNECTION_QUALITY = {
  EXCELLENT: { label: 'Excellent', color: 'text-green-400', bars: 4 },
  GOOD: { label: 'Good', color: 'text-yellow-400', bars: 3 },
  FAIR: { label: 'Fair', color: 'text-orange-400', bars: 2 },
  POOR: { label: 'Poor', color: 'text-red-400', bars: 1 }
} as const;

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

// Generate random room ID
export function generateRoomId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Validate email format
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Get random element from array
export function getRandomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

// Debounce function for search/typing
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), delay);
  };
}
