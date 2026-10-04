export interface UserProfile {
  name: string;
  profilePhoto?: string;
  language: string;
  country: string;
  coins: number;
}

export interface Language {
  code: string;
  name: string;
}

export interface Country {
  code: string;
  name: string;
  flag: string;
}

export interface AppState {
  step: 'home' | 'setup' | 'chat';
  user: UserProfile;
  isConnected: boolean;
  isSearching: boolean;
  coins: number;
}
