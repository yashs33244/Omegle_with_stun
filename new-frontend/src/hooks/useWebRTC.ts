import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { WebRTCState, IceCandidate } from '../types';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
  ],
};

const SOCKET_URL = 'http://localhost:3000';

interface UseWebRTCProps {
  localAudioTrack: MediaStreamTrack | null;
  localVideoTrack: MediaStreamTrack | null;
}

export const useWebRTC = ({ localAudioTrack, localVideoTrack }: UseWebRTCProps): WebRTCState => {
  const [lobby, setLobby] = useState<boolean>(true);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [sendingPc, setSendingPc] = useState<RTCPeerConnection | null>(null);
  const [receivingPc, setReceivingPc] = useState<RTCPeerConnection | null>(null);
  const [remoteVideoTrack, setRemoteVideoTrack] = useState<MediaStreamTrack | null>(null);
  const [remoteAudioTrack, setRemoteAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [remoteMediaStream, setRemoteMediaStream] = useState<MediaStream | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const socket: Socket = io(SOCKET_URL);
    
    const handleSendOffer = async ({ roomId }: { roomId: string }) => {
      setLobby(false);
      const pc = new RTCPeerConnection(ICE_SERVERS);
      setSendingPc(pc);

      if (localVideoTrack) pc.addTrack(localVideoTrack);
      if (localAudioTrack) pc.addTrack(localAudioTrack);

      pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
        if (e.candidate) {
          socket.emit('add-ice-candidate', {
            candidate: e.candidate,
            type: 'sender',
            roomId,
          });
        }
      };

      pc.onnegotiationneeded = async () => {
        try {
          const sdp = await pc.createOffer();
          await pc.setLocalDescription(sdp);
          socket.emit('offer', { sdp, roomId });
        } catch (error) {
          console.error('Error during negotiation:', error);
        }
      };
    };

    const handleOffer = async ({ roomId, sdp: remoteSdp }: { roomId: string; sdp: RTCSessionDescriptionInit }) => {
      setLobby(false);
      const pc = new RTCPeerConnection(ICE_SERVERS);
      await pc.setRemoteDescription(remoteSdp);
      const sdp = await pc.createAnswer();
      await pc.setLocalDescription(sdp);

      const stream = new MediaStream();
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
      }
      setRemoteMediaStream(stream);
      setReceivingPc(pc);

      pc.ontrack = (e: RTCTrackEvent) => {
        const track = e.track;
        if (track.kind === 'video') {
          setRemoteVideoTrack(track);
        } else {
          setRemoteAudioTrack(track);
        }

        if (remoteVideoRef.current && remoteVideoRef.current.srcObject instanceof MediaStream) {
          remoteVideoRef.current.srcObject.addTrack(track);
          remoteVideoRef.current.play().catch(console.error);
        }
      };

      pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
        if (e.candidate) {
          socket.emit('add-ice-candidate', {
            candidate: e.candidate,
            type: 'receiver',
            roomId,
          });
        }
      };

      socket.emit('answer', { roomId, sdp });
    };

    const handleIceCandidate = ({ candidate, type }: IceCandidate) => {
      if (type === 'sender') {
        setReceivingPc((pc) => {
          if (pc) {
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
          }
          return pc;
        });
      } else {
        setSendingPc((pc) => {
          if (pc) {
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
          }
          return pc;
        });
      }
    };

    socket.on('send-offer', handleSendOffer);
    socket.on('offer', handleOffer);
    socket.on('answer', ({ sdp: remoteSdp }: { sdp: RTCSessionDescriptionInit }) => {
      setLobby(false);
      setSendingPc(pc => {
        if (pc) {
          pc.setRemoteDescription(remoteSdp).catch(console.error);
        }
        return pc;
      });
    });

    socket.on('lobby', () => setLobby(true));
    socket.on('add-ice-candidate', handleIceCandidate);

    setSocket(socket);

    return () => {
      socket.disconnect();
      sendingPc?.close();
      receivingPc?.close();
    };
  }, [localAudioTrack, localVideoTrack]);

  return {
    lobby,
    remoteVideoRef,
    remoteVideoTrack,
    remoteAudioTrack
  };
};