export interface RoomProps {
    name: string;
    localAudioTrack: MediaStreamTrack | null;
    localVideoTrack: MediaStreamTrack | null;
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
    roomId: string;
  }
  
  export interface MediaStreamHookResult {
    localAudioTrack: MediaStreamTrack | null;
    localVideoTrack: MediaStreamTrack | null;
    videoRef: React.RefObject<HTMLVideoElement>;
  }
  export interface RoomProps {
    name: string;
    localAudioTrack: MediaStreamTrack | null;
    localVideoTrack: MediaStreamTrack | null;
  }
  
  