
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
}
