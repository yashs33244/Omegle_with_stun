import React, { useEffect, useRef, useState } from "react";
import { Socket, io } from "socket.io-client";
import { RoomProps } from "../types";
import { Loader, Video } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { UserRound } from "lucide-react";

const URL = "https://omegleapi.yashprojects.online/";

const iceServers: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
  ],
};

export const Room: React.FC<RoomProps> = ({
  name,
  localAudioTrack,
  localVideoTrack,
}) => {
  const [lobby, setLobby] = useState<boolean>(true);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [sendingPc, setSendingPc] = useState<RTCPeerConnection | null>(null);
  const [receivingPc, setReceivingPc] = useState<RTCPeerConnection | null>(
    null
  );
  const [remoteVideoTrack, setRemoteVideoTrack] =
    useState<MediaStreamTrack | null>(null);
  const [remoteAudioTrack, setRemoteAudioTrack] =
    useState<MediaStreamTrack | null>(null);
  const [remoteMediaStream, setRemoteMediaStream] =
    useState<MediaStream | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const socket: Socket = io(URL);

    socket.on("send-offer", async ({ roomId }: { roomId: string }) => {
      console.log("sending offer");
      setLobby(false);
      const pc = new RTCPeerConnection(iceServers);
      setSendingPc(pc);

      if (localVideoTrack) {
        console.error("added track");
        console.log(localVideoTrack);
        pc.addTrack(localVideoTrack);
      }
      if (localAudioTrack) {
        console.error("added track");
        console.log(localAudioTrack);
        pc.addTrack(localAudioTrack);
      }

      pc.onicecandidate = async (e) => {
        console.log("receiving ice candidate locally");
        if (e.candidate) {
          socket.emit("add-ice-candidate", {
            candidate: e.candidate,
            type: "sender",
            roomId,
          });
        }
      };

      pc.onnegotiationneeded = async () => {
        console.log("on negotiation needed, sending offer");
        const sdp = await pc.createOffer();
        await pc.setLocalDescription(sdp);
        socket.emit("offer", {
          sdp,
          roomId,
        });
      };
    });

    socket.on("offer", async ({ roomId, sdp: remoteSdp }) => {
      console.log("received offer");
      setLobby(false);
      const pc = new RTCPeerConnection(iceServers);
      await pc.setRemoteDescription(remoteSdp);
      const sdp = await pc.createAnswer();
      await pc.setLocalDescription(sdp);

      const stream = new MediaStream();
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
      }
      setRemoteMediaStream(stream);
      setReceivingPc(pc);

      pc.onicecandidate = async (e) => {
        if (!e.candidate) {
          return;
        }
        console.log("on ice candidate on receiving side");
        if (e.candidate) {
          socket.emit("add-ice-candidate", {
            candidate: e.candidate,
            type: "receiver",
            roomId,
          });
        }
      };

      socket.emit("answer", {
        roomId,
        sdp: sdp,
      });

      setTimeout(() => {
        const tracks = pc.getTransceivers();
        if (tracks.length >= 2) {
          const track1 = tracks[0].receiver.track;
          const track2 = tracks[1].receiver.track;
          console.log(track1);
          if (track1.kind === "video") {
            setRemoteAudioTrack(track2);
            setRemoteVideoTrack(track1);
          } else {
            setRemoteAudioTrack(track1);
            setRemoteVideoTrack(track2);
          }
          if (remoteVideoRef.current) {
            const stream = remoteVideoRef.current.srcObject;
            if (stream instanceof MediaStream) {
              stream.addTrack(track1);
              stream.addTrack(track2);
            }
            remoteVideoRef.current.play().catch(console.error);
          }
        }
      }, 5000);
    });

    socket.on("answer", ({ sdp: remoteSdp }) => {
      setLobby(false);
      setSendingPc((pc) => {
        if (pc) {
          pc.setRemoteDescription(remoteSdp).catch(console.error);
        }
        return pc;
      });
      console.log("loop closed");
    });

    socket.on("lobby", () => {
      setLobby(true);
    });

    socket.on("add-ice-candidate", ({ candidate, type }) => {
      console.log("add ice candidate from remote");
      console.log({ candidate, type });
      if (type === "sender") {
        setReceivingPc((pc) => {
          if (!pc) {
            console.error("receiving pc not found");
          } else {
            console.error(pc.ontrack);
          }
          pc?.addIceCandidate(candidate).catch(console.error);
          return pc;
        });
      } else {
        setSendingPc((pc) => {
          if (!pc) {
            console.error("sending pc not found");
          }
          pc?.addIceCandidate(candidate).catch(console.error);
          return pc;
        });
      }
    });

    setSocket(socket);

    return () => {
      socket.disconnect();
      sendingPc?.close();
      receivingPc?.close();
    };
  }, [localAudioTrack, localVideoTrack]);

  useEffect(() => {
    if (localVideoRef.current && localVideoTrack) {
      localVideoRef.current.srcObject = new MediaStream([localVideoTrack]);
      localVideoRef.current.play().catch(console.error);
    }
  }, [localVideoRef, localVideoTrack]);

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="w-full mx-auto px-4">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-center justify-between mb-6">
          <h2 className="text-3xl font-bold text-gray-900 mb-4 sm:mb-0">
            Welcome, {name}
          </h2>
          {lobby && (
            <div className="flex items-center gap-2 text-blue-600">
              <Loader className="w-5 h-5 animate-spin" />
              <span>Finding a connection...</span>
            </div>
          )}
        </div>

        {/* Video Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Local Video Card */}
          <Card className="overflow-hidden w-full">
            <CardContent className="p-0 h-full relative">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover bg-gray-900"
              />
              <div className="absolute bottom-3 left-3 flex items-center gap-2 bg-black/50 text-white px-3 py-1.5 rounded-full">
                <UserRound className="w-4 h-4" />
                <span className="text-sm">You</span>
              </div>
            </CardContent>
          </Card>

          {/* Remote Video Card */}
          <Card className="overflow-hidden w-full">
            <CardContent className="p-0 h-full relative">
              {!lobby ? (
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-cover bg-gray-900"
                />
              ) : (
                <div className="w-full h-full bg-gray-900 flex items-center justify-center">
                  <Video className="w-12 h-12 text-gray-600" />
                </div>
              )}
              <div className="absolute bottom-3 left-3 flex items-center gap-2 bg-black/50 text-white px-3 py-1.5 rounded-full">
                <UserRound className="w-4 h-4" />
                <span className="text-sm">Peer</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};
