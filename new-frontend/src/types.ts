export interface RoomProps {
  name: string;
  localAudioTrack: MediaStreamTrack | null;
  localVideoTrack: MediaStreamTrack | null;
  profilePhoto?: string;
  language: string;
  country: string;
  topics: string[];
  onBackToHome: () => void;
}

export interface WebRTCState {
  lobby: boolean;
  remoteVideoRef: React.RefObject<HTMLVideoElement>;
  remoteVideoTrack: MediaStreamTrack | null;
  remoteAudioTrack: MediaStreamTrack | null;
}

export interface IceCandidate {
  candidate: RTCIceCandidate;
  type: 'sender' | 'receiver';
}

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

export interface ChatMessage {
  id: string;
  text: string;
  sender: 'local' | 'remote';
  timestamp: Date;
}

export interface AppState {
  step: 'home' | 'setup' | 'chat';
  user: UserProfile;
  isConnected: boolean;
  isSearching: boolean;
  coins: number;
}
