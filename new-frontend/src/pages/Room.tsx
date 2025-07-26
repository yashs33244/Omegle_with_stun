import React, { useEffect, useRef, useState } from "react";
import { Socket, io } from "socket.io-client";
import { RoomProps, ChatMessage } from "../types";
import { useAudioLevelDetection } from "../hooks/useAudioLevelDetection";
import { useIsMobile } from "../hooks/use-mobile";

interface PartnerInfo {
  name: string;
  country?: string;
  language?: string;
  topics: string[];
  profilePhoto?: string;
}
import {
  Loader,
  Video,
  MessageCircle,
  SkipForward,
  Coins,
  UserRound,
  Home,
  Heart,
  Send,
  X,
  Check,
  Settings,
  Shield,
  Signal,
} from "lucide-react";
import { Card, CardContent } from "@/components/retroui/Card";
import { Button } from "@/components/retroui/Button";
import { Input } from "@/components/retroui/Input";
import { getCountryByCode } from "../lib/data";
import { ChatSettings } from "../components/ChatSettings";
import { ConnectionIndicator } from "../components/ConnectionIndicator";
import { formatConnectionTime } from "../lib/utils";

// const URL = "https://chizzybe.yashprojects.online/";
  const URL = "http://localhost:3004";

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
  profilePhoto,
  language,
  country,
  topics,
  onBackToHome,
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
  const [coins, setCoins] = useState<number>(100);
  const [connectionTime, setConnectionTime] = useState<number>(0);
  const [showChat, setShowChat] = useState<boolean>(false);
  const [isFriend, setIsFriend] = useState<boolean>(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentMessage, setCurrentMessage] = useState<string>("");
  const [remoteUserInfo, setRemoteUserInfo] = useState<{
    name?: string;
    country?: string;
  } | null>(null);
  const [matchState, setMatchState] = useState<
    "waiting" | "match-found" | "connecting" | "connected"
  >("waiting");
  const [partnerInfo, setPartnerInfo] = useState<PartnerInfo | null>(null);
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);
  const [partnerAccepted, setPartnerAccepted] = useState<boolean>(false);
  const [partnerName, setPartnerName] = useState<string>("");
  const [countdown, setCountdown] = useState<number>(5);
  const [showTimer, setShowTimer] = useState<boolean>(false);
  const [remoteVideoLoading, setRemoteVideoLoading] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [genderFilter, setGenderFilter] = useState<string>('all');
  const [preferredLanguage, setPreferredLanguage] = useState<string>('en');
  const [connectionQuality, setConnectionQuality] = useState<'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR'>('GOOD');
  const [textOnlyMode, setTextOnlyMode] = useState<boolean>(false);
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const [partnerIsTyping, setPartnerIsTyping] = useState<boolean>(false);

  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);

  const countryData = getCountryByCode(country);

  // Add mobile detection
  const isMobile = useIsMobile();

  // Audio level detection for speaking borders
  const { isSpeaking: localIsSpeaking } =
    useAudioLevelDetection(localAudioTrack);
  const { isSpeaking: remoteIsSpeaking } =
    useAudioLevelDetection(remoteAudioTrack);

  // Coin earning system and friend detection
  useEffect(() => {
    if (!lobby && intervalRef.current === null) {
      intervalRef.current = setInterval(() => {
        setConnectionTime((prev) => {
          const newTime = prev + 1;

          // Earn 5 coins per minute
          if (newTime % 60 === 0) {
            setCoins((prevCoins) => prevCoins + 5);
            const coinElement = document.querySelector(".coin-counter");
            if (coinElement) {
              coinElement.classList.add("animate-coin-pop");
              setTimeout(() => {
                coinElement.classList.remove("animate-coin-pop");
              }, 300);
            }
          }

          // Become friends after 5 minutes
          if (newTime === 300 && !isFriend) {
            setIsFriend(true);
            // Show friend notification
            addSystemMessage(
              "🎉 You are now friends! You've been chatting for 5 minutes."
            );
          }

          return newTime;
        });
      }, 1000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [lobby, isFriend]);

  // Auto scroll chat messages
  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [messages]);

  // Countdown timer for auto-skip
  useEffect(() => {
    if (matchState === "match-found") {
      setShowTimer(true);
      setCountdown(5);

      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            setShowTimer(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      return () => {
        clearInterval(timer);
        setShowTimer(false);
      };
    }
  }, [matchState]);

  const addSystemMessage = (text: string) => {
    const systemMessage: ChatMessage = {
      id: Date.now().toString(),
      text,
      sender: "local",
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, systemMessage]);
  };

  const sendMessage = () => {
    if (currentMessage.trim() && socket) {
      const message: ChatMessage = {
        id: Date.now().toString(),
        text: currentMessage.trim(),
        sender: "local",
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, message]);

      // Send to socket
      socket.emit("chat-message", {
        message: currentMessage.trim(),
        timestamp: new Date().toISOString(),
      });

      setCurrentMessage("");
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      sendMessage();
      setIsTyping(false);
    }
  };

  const handleTyping = (value: string) => {
    setCurrentMessage(value);
    
    if (value.trim() && !isTyping) {
      setIsTyping(true);
      socket?.emit("typing", { typing: true });
    } else if (!value.trim() && isTyping) {
      setIsTyping(false);
      socket?.emit("typing", { typing: false });
    }
  };

  const toggleTextOnlyMode = () => {
    setTextOnlyMode(!textOnlyMode);
    if (!textOnlyMode) {
      // Hide video elements when switching to text-only
      addSystemMessage("Switched to text-only mode. Video is now hidden.");
    } else {
      addSystemMessage("Switched to video mode. Video is now visible.");
    }
  };

  const handleAcceptMatch = () => {
    if (socket && currentRoomId) {
      socket.emit("accept-match", { roomId: currentRoomId });
      console.log("Accepted match");
    }
  };

  const handleRejectMatch = () => {
    if (socket && currentRoomId) {
      socket.emit("reject-match", { roomId: currentRoomId });
      console.log("Rejected match");
    }
  };

  const handleSkipUser = () => {
    if (socket) {
      socket.emit("skip-user");
      console.log("Skipped user");
    }
  };

  const handleReport = (reason: string, description?: string) => {
    if (socket) {
      socket.emit("report-user", { reason, description });
      console.log("Reported user:", reason);
      addSystemMessage("User reported. Thank you for helping keep our community safe.");
    }
  };

  const handleGenderFilterChange = (gender: string) => {
    setGenderFilter(gender);
    if (socket) {
      socket.emit("update-preferences", { genderFilter: gender, language: preferredLanguage });
    }
  };

  const handleLanguageChange = (language: string) => {
    setPreferredLanguage(language);
    if (socket) {
      socket.emit("update-preferences", { genderFilter, language });
    }
  };

  const toggleChat = () => {
    setShowChat(!showChat);
  };

  useEffect(() => {
    const socket: Socket = io(URL);

    // Send user info when connecting
    socket.emit("user-info", {
      name,
      country,
      topics,
      language,
      profilePhoto,
    });

    socket.on("send-offer", async ({ roomId }: { roomId: string }) => {
      console.log("sending offer");
      setLobby(false);
      setMatchState("connected");
      const pc = new RTCPeerConnection(iceServers);
      setSendingPc(pc);

      if (localVideoTrack) {
        console.log("added video track");
        pc.addTrack(localVideoTrack);
      }
      if (localAudioTrack) {
        console.log("added audio track");
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
      setMatchState("connected");
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
          setRemoteVideoLoading(true);
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

            // Add event listeners for video loading
            const video = remoteVideoRef.current;
            const handleLoadedData = () => {
              setRemoteVideoLoading(false);
              video.removeEventListener("loadeddata", handleLoadedData);
            };

            video.addEventListener("loadeddata", handleLoadedData);
            video.play().catch(console.error);
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
      setMatchState("waiting");
      setPartnerInfo(null);
      setCurrentRoomId(null);
      setPartnerAccepted(false);
      setPartnerName("");
      setShowTimer(false);
      setRemoteVideoLoading(false);
    });

    // New match found event
    socket.on(
      "match-found",
      ({
        roomId,
        partnerInfo,
      }: {
        roomId: string;
        partnerInfo: PartnerInfo;
      }) => {
        console.log("Match found:", partnerInfo);
        setMatchState("match-found");
        setPartnerInfo(partnerInfo);
        setCurrentRoomId(roomId);
      }
    );

    // Match accepted by both users
    socket.on("match-accepted", ({ roomId }: { roomId: string }) => {
      console.log("Match accepted, starting connection");
      setMatchState("connecting");
    });

    // Match rejected
    socket.on("match-rejected", () => {
      console.log("Match was rejected");
      setMatchState("waiting");
      setPartnerInfo(null);
      setCurrentRoomId(null);
      setPartnerAccepted(false);
      setPartnerName("");
      setShowTimer(false);
      addSystemMessage(
        "The other user declined the match. Looking for someone else..."
      );
    });

    // Partner accepted (but you're still pending)
    socket.on(
      "partner-accepted",
      ({ partnerName, roomId }: { partnerName: string; roomId: string }) => {
        console.log("Partner accepted:", partnerName);
        setPartnerAccepted(true);
        setPartnerName(partnerName);
      }
    );

    // User skipped
    socket.on("user-skipped", ({ message }: { message: string }) => {
      console.log("User skipped:", message);
      addSystemMessage(message);
      setMatchState("waiting");
      setPartnerInfo(null);
      setCurrentRoomId(null);
      setPartnerAccepted(false);
      setPartnerName("");
      setShowTimer(false);
    });

    // Auto-skipped match
    socket.on("match-auto-skipped", ({ message }: { message: string }) => {
      console.log("Match auto-skipped:", message);
      addSystemMessage(message);
      setMatchState("waiting");
      setPartnerInfo(null);
      setCurrentRoomId(null);
      setPartnerAccepted(false);
      setPartnerName("");
      setShowTimer(false);
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

    // Chat message handler
    socket.on("chat-message", ({ message, timestamp, sender }) => {
      const newMessage: ChatMessage = {
        id: Date.now().toString(),
        text: message,
        sender: "remote",
        timestamp: new Date(timestamp),
      };
      setMessages((prev) => [...prev, newMessage]);
    });

    // Remote user info handler
    socket.on("remote-user-info", (userInfo) => {
      setRemoteUserInfo(userInfo);
    });

    // Typing indicator handlers
    socket.on("typing", ({ typing }) => {
      setPartnerIsTyping(typing);
    });

    // Handle user disconnection
    socket.on("user-disconnected", ({ message }) => {
      console.log("Other user disconnected:", message);
      addSystemMessage("Your chat partner has disconnected");

      // Reset connection state
      setLobby(true);
      setMatchState("waiting");
      setPartnerInfo(null);
      setCurrentRoomId(null);
      setRemoteVideoTrack(null);
      setRemoteAudioTrack(null);
      setRemoteMediaStream(null);
      setRemoteUserInfo(null);
      setMessages([]);
      setConnectionTime(0);
      setIsFriend(false);
      setShowTimer(false);
      setRemoteVideoLoading(false);

      // Close peer connections
      if (sendingPc) {
        sendingPc.close();
        setSendingPc(null);
      }
      if (receivingPc) {
        receivingPc.close();
        setReceivingPc(null);
      }
    });

    setSocket(socket);

    return () => {
      // Emit leave-room event before disconnecting
      socket.emit("leave-room");
      socket.disconnect();
      sendingPc?.close();
      receivingPc?.close();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [localAudioTrack, localVideoTrack, name, country, topics, language]);

  useEffect(() => {
    if (localVideoRef.current && localVideoTrack) {
      localVideoRef.current.srcObject = new MediaStream([localVideoTrack]);
      localVideoRef.current.play().catch(console.error);
    }
  }, [localVideoRef, localVideoTrack]);

  const formatTime = (seconds: number) => {
    return formatConnectionTime(seconds);
  };

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      {/* Header with coins and connection info */}
      <div className={`flex items-center justify-between ${
        isMobile ? "p-2" : "p-4"
      } bg-black bg-opacity-80 backdrop-blur-sm border-b border-gray-700`}>
        <div className={`flex items-center ${isMobile ? "gap-2" : "gap-4"}`}>
          <button
            onClick={() => {
              if (socket) {
                socket.emit("leave-room");
              }
              onBackToHome();
            }}
            className="text-yellow-400 hover:text-yellow-300 transition-colors"
          >
            <h1 className={`${isMobile ? "text-lg" : "text-2xl"} font-bold`}>Chizzy</h1>
          </button>
          <div className={`coin-counter flex items-center gap-2 bg-yellow-500 bg-opacity-20 ${
            isMobile ? "px-2 py-1" : "px-3 py-1"
          } rounded-full border border-yellow-500`}>
            <Coins className={`${isMobile ? "w-4 h-4" : "w-5 h-5"} text-yellow-400`} />
            <span className={`font-bold text-yellow-400 ${isMobile ? "text-sm" : ""}`}>{coins}</span>
          </div>
          {isFriend && (
            <div className={`flex items-center gap-2 bg-pink-500 bg-opacity-20 ${
              isMobile ? "px-2 py-1" : "px-3 py-1"
            } rounded-full border border-pink-500`}>
              <Heart className={`${isMobile ? "w-4 h-4" : "w-5 h-5"} text-pink-400`} />
              <span className={`font-bold text-pink-400 ${isMobile ? "text-sm" : ""}`}>Friends</span>
            </div>
          )}
        </div>

        <div className={`flex items-center ${isMobile ? "gap-1" : "gap-4"}`}>
          {matchState === "connected" && !isMobile && (
            <div className="flex items-center gap-2 text-white text-sm">
              <ConnectionIndicator quality={connectionQuality} />
              <span>Connected: {formatTime(connectionTime)}</span>
            </div>
          )}
          {matchState === "connected" && isMobile && (
            <ConnectionIndicator quality={connectionQuality} />
          )}
          <Button
            onClick={() => setShowSettings(true)}
            variant="outline"
            size={isMobile ? "sm" : "sm"}
            className={`flex items-center ${
              isMobile ? "gap-1 px-2" : "gap-2"
            } bg-gray-800 border-gray-600 text-white hover:bg-gray-700`}
          >
            <Settings className="w-4 h-4" />
            {!isMobile && "Settings"}
          </Button>
          {matchState === "connected" && (
            <Button
              onClick={handleSkipUser}
              variant="outline"
              size={isMobile ? "sm" : "sm"}
              className={`flex items-center ${
                isMobile ? "gap-1 px-2" : "gap-2"
              } bg-orange-600 border-orange-500 text-white hover:bg-orange-500`}
            >
              <SkipForward className="w-4 h-4" />
              {!isMobile && "Skip"}
            </Button>
          )}
          <Button
            onClick={() => {
              if (socket) {
                socket.emit("leave-room");
              }
              onBackToHome();
            }}
            variant="outline"
            size={isMobile ? "sm" : "sm"}
            className={`flex items-center ${
              isMobile ? "gap-1 px-2" : "gap-2"
            } bg-gray-800 border-gray-600 text-white hover:bg-gray-700`}
          >
            <Home className="w-4 h-4" />
            {!isMobile && "Home"}
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex">
        <div
          className={`flex-1 grid ${
            textOnlyMode
              ? "grid-cols-1 gap-4 p-4"
              : isMobile 
                ? showChat 
                  ? "grid-cols-1 gap-2 p-2" 
                  : "grid-cols-1 gap-2 p-2"
                : showChat 
                  ? "lg:grid-cols-2 gap-4 p-4" 
                  : "grid-cols-2 gap-4 p-4"
          }`}
        >
          {/* Local Video */}
          {!textOnlyMode && (
            <div
              className={`retro-video-card ${localIsSpeaking ? "speaking" : ""}`}
            >
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
              style={{ transform: "scaleX(-1)" }}
            />

            {/* User info overlay with better visibility */}
            <div className="absolute bottom-4 left-4 flex items-center gap-2">
              {profilePhoto && (
                <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-white">
                  <img
                    src={profilePhoto}
                    alt="Profile"
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
              <div className="bg-black bg-opacity-80 backdrop-blur-sm text-white px-4 py-2 rounded-full flex items-center gap-2">
                <UserRound className="w-4 h-4" />
                <span className="text-sm font-medium">{name}</span>
                {countryData && (
                  <span className="text-sm">{countryData.flag}</span>
                )}
              </div>
            </div>

            {/* Chat toggle button */}
            {matchState === "connected" && (
              <div className="absolute top-4 right-4">
                <Button
                  onClick={toggleChat}
                  variant={showChat ? "default" : "outline"}
                  size="sm"
                  className={`flex items-center gap-2 ${
                    showChat
                      ? "bg-yellow-500 text-black"
                      : "bg-black bg-opacity-60 text-white border-white"
                  }`}
                >
                  <MessageCircle className="w-4 h-4" />
                  Chat
                </Button>
              </div>
            )}
            </div>
          )}

          {/* Remote Video / Text Chat Area */}
          <div
            className={`${
              textOnlyMode 
                ? "bg-gray-800 rounded-lg p-6 border border-gray-700 h-full flex flex-col"
                : `retro-video-card ${
                    remoteIsSpeaking ? "speaking" : ""
                  } ${
                    matchState === "match-found" && showTimer
                      ? "timer-border-beam"
                      : ""
                  }`
            }`}
          >
            {textOnlyMode ? (
              // Text-only mode interface
              <div className="flex-1 flex flex-col justify-center items-center text-center space-y-4">
                <MessageCircle className="w-16 h-16 text-yellow-400" />
                <div className="text-white space-y-2">
                  <h3 className="text-xl font-bold">Text Chat Mode</h3>
                  <p className="text-gray-300">
                    You're chatting with{" "}
                    {partnerInfo?.name || remoteUserInfo?.name || "a stranger"}
                  </p>
                  {partnerIsTyping && (
                    <div className="flex items-center justify-center gap-2 text-yellow-400">
                      <div className="flex space-x-1">
                        <div className="w-2 h-2 bg-yellow-400 rounded-full animate-bounce"></div>
                        <div className="w-2 h-2 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                        <div className="w-2 h-2 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                      </div>
                      <span className="text-sm">Partner is typing...</span>
                    </div>
                  )}
                </div>
                <Button
                  onClick={toggleTextOnlyMode}
                  variant="outline"
                  className="bg-yellow-500 text-black hover:bg-yellow-400"
                >
                  <Video className="w-4 h-4 mr-2" />
                  Switch to Video
                </Button>
              </div>
            ) : matchState === "connected" ? (
              <>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-cover"
                  style={{
                    filter: "brightness(1.1) contrast(1.1) saturate(1.1)", // Enhance clarity
                    transform: "scaleX(-1)", // Mirror effect
                    zIndex: 3,
                    position: "relative",
                  }}
                />
                {remoteVideoLoading && (
                  <div className="video-loading-overlay">
                    <div className="text-center text-white space-y-4">
                      <div className="loading-spinner"></div>
                      <p className="text-lg font-medium">Connecting video...</p>
                    </div>
                  </div>
                )}
              </>
            ) : matchState === "match-found" && partnerInfo ? (
              // Show partner's thumbnail with accept/reject buttons
              <div
                className="w-full h-full bg-black flex items-center justify-center relative"
                style={{ zIndex: 3 }}
              >
                {partnerInfo.profilePhoto ? (
                  <img
                    src={partnerInfo.profilePhoto}
                    alt="Partner"
                    className="w-full h-full object-cover"
                    style={{ transform: "scaleX(-1)" }}
                  />
                ) : (
                  <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                    <UserRound className="w-32 h-32 text-gray-400" />
                  </div>
                )}

                {/* Timer countdown */}
                {showTimer && <div className="timer-text">{countdown}s</div>}

                {/* Partner info overlay */}
                <div className="absolute bottom-4 left-4 bg-black bg-opacity-80 backdrop-blur-sm text-white px-4 py-2 rounded-full flex items-center gap-2">
                  <UserRound className="w-4 h-4" />
                  <span className="text-sm font-medium">
                    {partnerInfo.name}
                  </span>
                  {partnerInfo.country &&
                    getCountryByCode(partnerInfo.country) && (
                      <span className="text-sm">
                        {getCountryByCode(partnerInfo.country)?.flag}
                      </span>
                    )}
                </div>

                {/* Accept/Reject buttons */}
                <div className="match-overlay" style={{ zIndex: 4 }}>
                  <div className="text-center space-y-6">
                    <div className="text-white space-y-2">
                      <h3 className="text-2xl font-bold">
                        Someone wants to chat!
                      </h3>
                      <p className="text-gray-300">
                        {partnerInfo.name} from{" "}
                        {partnerInfo.country &&
                          getCountryByCode(partnerInfo.country)?.name}
                      </p>
                      <p className="text-sm text-gray-400">
                        Interested in:{" "}
                        {partnerInfo.topics
                          .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
                          .join(", ")}
                      </p>
                      {partnerAccepted && (
                        <div className="bg-green-500 bg-opacity-20 border border-green-500 rounded-lg p-2 mt-3">
                          <p className="text-green-400 text-sm">
                            ✅ {partnerName} has accepted! Waiting for your
                            response...
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="flex gap-4">
                      <button
                        onClick={handleRejectMatch}
                        className="retro-button bg-red-500 border-red-600 text-white hover:bg-red-400"
                      >
                        <X className="w-5 h-5 inline mr-2" />
                        Pass
                      </button>
                      <button
                        onClick={handleAcceptMatch}
                        className="retro-button bg-green-500 border-green-600 text-white hover:bg-green-400"
                      >
                        <Check className="w-5 h-5 inline mr-2" />
                        Accept
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : matchState === "connecting" ? (
              <div
                className="w-full h-full bg-black flex items-center justify-center"
                style={{ zIndex: 3 }}
              >
                <div className="text-center space-y-4">
                  <Loader className="w-16 h-16 text-yellow-400 animate-spin mx-auto" />
                  <div className="text-white space-y-2">
                    <p className="text-xl font-medium">Connecting...</p>
                    <p className="text-sm text-gray-300">
                      Both users accepted! Setting up video call...
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              // Waiting state
              <div
                className="w-full h-full bg-black flex items-center justify-center"
                style={{ zIndex: 3 }}
              >
                <div className="text-center space-y-4">
                  {profilePhoto ? (
                    <div className="w-20 h-20 mx-auto rounded-full overflow-hidden border-4 border-yellow-500 animate-pulse">
                      <img
                        src={profilePhoto}
                        alt="Profile"
                        className="w-full h-full object-cover"
                        style={{ transform: "scaleX(-1)" }}
                      />
                    </div>
                  ) : (
                    <Loader className="w-16 h-16 text-yellow-400 animate-spin mx-auto" />
                  )}
                  <div className="text-white space-y-2">
                    <p className="text-xl font-medium">
                      Looking for someone...
                    </p>
                    <p className="text-sm text-gray-300">
                      Matching with users interested in:{" "}
                      {topics
                        .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
                        .join(", ")}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {matchState === "connected" && !textOnlyMode && (
              <div className="absolute bottom-4 left-4 bg-black bg-opacity-80 backdrop-blur-sm text-white px-4 py-2 rounded-full flex items-center gap-2">
                <UserRound className="w-4 h-4" />
                <span className="text-sm font-medium">
                  {partnerInfo?.name || remoteUserInfo?.name || "Stranger"}
                </span>
                {(partnerInfo?.country || remoteUserInfo?.country) &&
                  getCountryByCode(
                    partnerInfo?.country || remoteUserInfo?.country || ""
                  ) && (
                    <span className="text-sm">
                      {
                        getCountryByCode(
                          partnerInfo?.country || remoteUserInfo?.country || ""
                        )?.flag
                      }
                    </span>
                  )}
              </div>
            )}

            {/* Text-only mode toggle button */}
            {matchState === "connected" && !textOnlyMode && (
              <div className="absolute top-4 left-4">
                <Button
                  onClick={toggleTextOnlyMode}
                  variant="outline"
                  size="sm"
                  className="bg-black bg-opacity-60 text-white border-white hover:bg-gray-800"
                >
                  <MessageCircle className="w-4 h-4 mr-2" />
                  Text Only
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Chat Panel - Always show in text-only mode */}
        {(showChat || textOnlyMode) && matchState === "connected" && (
                      <div className={`${
              textOnlyMode
                ? "flex-1 bg-gray-800 border-l border-gray-700"
                : isMobile 
                  ? "fixed inset-0 z-50 bg-gray-800 border-gray-700" 
                  : "w-80 bg-gray-800 border-l border-gray-700"
            } flex flex-col`}>
            {/* Chat Header */}
                          <div className="p-4 border-b border-gray-700 flex items-center justify-between">
                <h3 className="font-medium text-white">
                  {textOnlyMode ? "Text Chat" : "Chat"}
                </h3>
                <div className="flex items-center gap-2">
                  {partnerIsTyping && !textOnlyMode && (
                    <span className="text-xs text-yellow-400 flex items-center gap-1">
                      <div className="flex space-x-1">
                        <div className="w-1 h-1 bg-yellow-400 rounded-full animate-bounce"></div>
                        <div className="w-1 h-1 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                        <div className="w-1 h-1 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                      </div>
                      typing...
                    </span>
                  )}
                  {(isMobile && !textOnlyMode) && (
                    <Button
                      onClick={() => setShowChat(false)}
                      variant="outline"
                      size="sm"
                      className="bg-gray-700 border-gray-600 text-white hover:bg-gray-600"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>

            {/* Messages */}
            <div
              ref={chatMessagesRef}
              className="flex-1 p-4 overflow-y-auto space-y-3"
            >
              {messages.length === 0 ? (
                <p className="text-gray-400 text-center text-sm">
                  Start a conversation! Say hello 👋
                </p>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${
                      message.sender === "local"
                        ? "justify-end"
                        : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-xs px-3 py-2 rounded-lg text-sm ${
                        message.sender === "local"
                          ? "bg-yellow-500 text-black"
                          : "bg-gray-700 text-white"
                      }`}
                    >
                      {message.text}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Chat Input */}
            <div className="p-4 border-t border-gray-700">
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="Type a message..."
                  value={currentMessage}
                  onChange={(e) => handleTyping(e.target.value)}
                  onKeyPress={handleKeyPress}
                  className="flex-1 bg-gray-700 border-gray-600 text-white placeholder-gray-400 focus:border-yellow-500"
                />
                <Button
                  onClick={sendMessage}
                  disabled={!currentMessage.trim()}
                  size="sm"
                  className="bg-yellow-500 text-black hover:bg-yellow-400"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Settings Panel */}
        <ChatSettings
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          onGenderFilterChange={handleGenderFilterChange}
          onLanguageChange={handleLanguageChange}
          onReport={handleReport}
          currentGenderFilter={genderFilter}
          currentLanguage={preferredLanguage}
          canReport={matchState === "connected"}
        />
      </div>
    </div>
  );
};
