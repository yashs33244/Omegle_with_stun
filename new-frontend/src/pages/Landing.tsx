import React, { useState, useRef, useEffect } from "react";
import { useMediaStream } from "../hooks/useMediaStream";
import { Room } from "./Room";
import { Camera, Loader, User, X, Languages, Globe } from "lucide-react";
import { Button } from "@/components/retroui/Button";
import { Input } from "@/components/retroui/Input";
import { Select, SelectItem } from "@/components/retroui/Select";
import {
  getCountryByCode,
  getLanguageByCode,
  languages,
  countries,
} from "../lib/data";
import { UserProfile } from "../types";

// Topics list
const topics = [
  { id: "general", name: "General Chat", emoji: "💬" },
  { id: "gaming", name: "Gaming", emoji: "🎮" },
  { id: "music", name: "Music", emoji: "🎵" },
  { id: "movies", name: "Movies", emoji: "🎬" },
  { id: "sports", name: "Sports", emoji: "⚽" },
  { id: "technology", name: "Technology", emoji: "💻" },
  { id: "art", name: "Art & Design", emoji: "🎨" },
  { id: "travel", name: "Travel", emoji: "✈️" },
  { id: "food", name: "Food", emoji: "🍕" },
  { id: "books", name: "Books", emoji: "📚" },
];

// Enhanced face detection hook
const useSimpleFaceDetection = (
  videoRef: React.RefObject<HTMLVideoElement>,
  stream: MediaStream | null
) => {
  const [faceDetected, setFaceDetected] = useState<boolean>(false);

  useEffect(() => {
    const interval = setInterval(() => {
      if (videoRef.current && stream) {
        const video = videoRef.current;
        const hasVideo =
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          !video.paused &&
          !video.ended &&
          stream.active;
        setFaceDetected(hasVideo);
      } else {
        setFaceDetected(false);
      }
    }, 1000); // Check every second

    return () => clearInterval(interval);
  }, [videoRef, stream]);

  return { faceDetected };
};

// Simple Modal Component
const Modal = ({
  isOpen,
  onClose,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black bg-opacity-80"
        onClick={onClose}
      />
      <div className="relative bg-white rounded-lg p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-500 hover:text-gray-700"
        >
          <X className="w-5 h-5" />
        </button>
        {children}
      </div>
    </div>
  );
};

export const Landing = () => {
  const [step, setStep] = useState<"home" | "setup" | "chat">("home");
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupStep, setSetupStep] = useState<"capture" | "details">("capture");
  const [user, setUser] = useState<UserProfile>({
    name: "",
    profilePhoto: undefined,
    language: "en",
    country: "IN",
    coins: 100,
  });
  const [selectedTopics, setSelectedTopics] = useState<string[]>(["general"]);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);

  const {
    localAudioTrack,
    localVideoTrack,
    videoRef,
    hasPermission,
    isLoading,
    error,
    getCam,
    restartStream,
    stream,
  } = useMediaStream();

  const { faceDetected } = useSimpleFaceDetection(videoRef, stream);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modalVideoRef = useRef<HTMLVideoElement>(null);

  // Sync modal video with main video stream
  useEffect(() => {
    if (modalVideoRef.current && stream && showSetupModal) {
      modalVideoRef.current.srcObject = stream;

      // Set up event listeners for better video loading
      const video = modalVideoRef.current;

      const handleLoadedMetadata = () => {
        console.log("Modal video metadata loaded:", {
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          readyState: video.readyState,
        });
      };

      const handleCanPlay = () => {
        console.log("Modal video can play");
        video.play().catch((err) => {
          console.log("Modal video play failed:", err);
        });
      };

      video.addEventListener("loadedmetadata", handleLoadedMetadata);
      video.addEventListener("canplay", handleCanPlay);

      // Force load if needed
      if (video.readyState >= 1) {
        handleLoadedMetadata();
      }
      if (video.readyState >= 3) {
        handleCanPlay();
      }

      return () => {
        video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        video.removeEventListener("canplay", handleCanPlay);
      };
    }
  }, [stream, showSetupModal]);

  // Force camera re-initialization when modal opens
  useEffect(() => {
    if (showSetupModal && !stream) {
      getCam();
    }
  }, [showSetupModal]);

  // Ensure modal video gets the stream when it becomes available
  useEffect(() => {
    if (
      modalVideoRef.current &&
      stream &&
      showSetupModal &&
      !modalVideoRef.current.srcObject
    ) {
      console.log("Setting up modal video stream");
      modalVideoRef.current.srcObject = stream;
    }
  }, [stream, showSetupModal]);

  // Restart camera when returning to home page (step === "home")
  useEffect(() => {
    if (step === "home" && !stream && !isLoading) {
      console.log("Restarting camera stream on homepage return");
      restartStream();
    }
  }, [step, stream, isLoading, restartStream]);

  const capturePhoto = () => {
    const videoElement = modalVideoRef.current;

    if (videoElement && canvasRef.current && stream) {
      setIsCapturing(true);

      const attemptCapture = () => {
        const canvas = canvasRef.current;
        const video = videoElement;

        if (!canvas || !video) {
          setIsCapturing(false);
          return;
        }

        // Use default dimensions if video dimensions aren't available yet
        const width = video.videoWidth || 640;
        const height = video.videoHeight || 480;

        console.log("Attempting capture with dimensions:", {
          width,
          height,
          readyState: video.readyState,
        });

        // Set canvas dimensions
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (ctx) {
          try {
            // Clear canvas first
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Save the context to flip horizontally (mirror effect)
            ctx.save();
            ctx.scale(-1, 1);
            ctx.translate(-canvas.width, 0);

            // Draw the video frame to canvas (mirrored)
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            // Restore the context
            ctx.restore();

            // Convert to data URL with high quality
            const photoDataUrl = canvas.toDataURL("image/jpeg", 0.9);

            // Verify the photo was captured (check if it's not just black)
            if (photoDataUrl && photoDataUrl.length > 5000) {
              setUser((prev) => ({ ...prev, profilePhoto: photoDataUrl }));
              setSetupStep("details");
              console.log(
                "Photo captured successfully!",
                photoDataUrl.length,
                "bytes"
              );
            } else {
              console.error(
                "Photo capture failed - image too small or black",
                photoDataUrl.length
              );
            }
          } catch (error) {
            console.error("Error during photo capture:", error);
          }
        }

        setIsCapturing(false);
      };

      // Try immediately first
      attemptCapture();
    } else {
      console.log("Cannot capture photo:", {
        videoElement: !!videoElement,
        canvas: !!canvasRef.current,
        stream: !!stream,
      });
    }
  };

  const handleStartClick = () => {
    setShowSetupModal(true);
  };

  const handleStartChatting = () => {
    if (user.name.trim() && selectedTopics.length > 0) {
      setShowSetupModal(false);
      setStep("chat");
    }
  };

  const toggleTopic = (topicId: string) => {
    setSelectedTopics((prev) =>
      prev.includes(topicId)
        ? prev.filter((id) => id !== topicId)
        : [...prev, topicId]
    );
  };

  const countryData = getCountryByCode(user.country);
  const languageData = getLanguageByCode(user.language);

  // Show error if there's one
  if (error) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center text-white">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Camera Error</h1>
          <p className="mb-4">{error}</p>
          <Button onClick={getCam} className="bg-yellow-500 text-black">
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  // Home page view with full-screen design
  if (step === "home") {
    return (
      <div className="relative min-h-screen overflow-hidden">
        {/* Full-screen video background */}
        <div className="absolute inset-0 z-0">
          {hasPermission ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
              style={{ transform: "scaleX(-1)" }} // Mirror effect
            />
          ) : (
            <div className="w-full h-full bg-gray-900 flex items-center justify-center">
              {isLoading ? (
                <div className="text-center text-white space-y-4">
                  <Loader className="w-12 h-12 animate-spin mx-auto" />
                  <p>Accessing camera...</p>
                </div>
              ) : (
                <div className="text-center text-white space-y-4">
                  <Camera className="w-16 h-16 mx-auto text-gray-400" />
                  <p className="text-xl">Camera access required</p>
                  <Button
                    onClick={getCam}
                    className="bg-yellow-500 text-black hover:bg-yellow-400"
                  >
                    Enable Camera
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Overlay content */}
        <div className="relative z-10 min-h-screen bg-black bg-opacity-40 flex">
          {/* Left sidebar */}
          <div className="w-80 bg-black bg-opacity-60 backdrop-blur-sm p-6 flex flex-col justify-between text-white">
            <div className="space-y-6">
              {/* Logo */}
              <div className="text-center">
                <h1 className="text-3xl font-bold text-yellow-400">Chizzy</h1>
              </div>

              {/* User Profile Section */}
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setShowSetupModal(true)}
                    className="w-12 h-12 rounded-full bg-yellow-500 flex items-center justify-center overflow-hidden hover:bg-yellow-400 transition-colors cursor-pointer"
                  >
                    {user.profilePhoto ? (
                      <img
                        src={user.profilePhoto}
                        alt="Profile"
                        className="w-full h-full object-cover"
                        style={{ transform: "scaleX(-1)" }}
                      />
                    ) : (
                      <User className="w-6 h-6 text-black" />
                    )}
                  </button>
                  <div>
                    <p className="font-medium">{user.name || "Guest User"}</p>
                    <div className="flex items-center gap-2 text-sm text-gray-300">
                      <span>{countryData?.flag}</span>
                      <span>{countryData?.name}</span>
                    </div>
                  </div>
                </div>

                {/* Language */}
                <div className="flex items-center gap-2 text-sm">
                  <Languages className="w-4 h-4" />
                  <span>I speak: {languageData?.name}</span>
                </div>

                {/* Topics */}
                <div className="space-y-2">
                  <h3 className="font-medium text-sm">My topics:</h3>
                  <div className="flex flex-wrap gap-2">
                    {selectedTopics.slice(0, 3).map((topicId) => {
                      const topic = topics.find((t) => t.id === topicId);
                      return topic ? (
                        <div
                          key={topic.id}
                          className="px-2 py-1 bg-white bg-opacity-20 rounded-full text-xs flex items-center gap-1"
                        >
                          <span>{topic.emoji}</span>
                          <span>{topic.name}</span>
                        </div>
                      ) : null;
                    })}
                  </div>
                  <button
                    onClick={() => setShowSetupModal(true)}
                    className="text-yellow-400 text-xs hover:underline"
                  >
                    Edit profile
                  </button>
                </div>

                {/* Face Detection Status */}
                <div className="flex items-center gap-2 text-sm">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      faceDetected ? "bg-green-400" : "bg-red-400"
                    }`}
                  />
                  <span>
                    {faceDetected ? "Camera ready" : "Initializing camera..."}
                  </span>
                </div>
              </div>
            </div>

            {/* Settings */}
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-xs text-gray-300">Language</label>
                <Select
                  value={user.language}
                  onValueChange={(lang) =>
                    setUser((prev) => ({ ...prev, language: lang }))
                  }
                >
                  {languages.map((lang) => (
                    <SelectItem key={lang.code} value={lang.code}>
                      {lang.name}
                    </SelectItem>
                  ))}
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs text-gray-300">Country</label>
                <Select
                  value={user.country}
                  onValueChange={(country) =>
                    setUser((prev) => ({ ...prev, country }))
                  }
                >
                  {countries.map((country) => (
                    <SelectItem key={country.code} value={country.code}>
                      {country.flag} {country.name}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            </div>
          </div>

          {/* Right side with start button */}
          <div className="flex-1 flex items-end justify-center pb-20">
            <div className="text-center space-y-4">
              <Button
                onClick={handleStartClick}
                disabled={!hasPermission}
                size="lg"
                className="px-16 py-4 text-xl font-bold bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed border-2 border-black shadow-lg"
              >
                Start
              </Button>

              {!hasPermission && (
                <p className="text-white text-sm">
                  Please allow camera access to continue
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Hidden canvas for photo capture */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Setup Modal */}
        <Modal isOpen={showSetupModal} onClose={() => setShowSetupModal(false)}>
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-xl font-bold text-black">
                {setupStep === "capture"
                  ? "Capture Your Photo"
                  : "Complete Profile"}
              </h2>
              <p className="text-gray-600 mt-2">
                {setupStep === "capture"
                  ? "Take a real-time photo for your profile"
                  : "Enter your details and select topics"}
              </p>
            </div>

            {setupStep === "capture" ? (
              <div className="space-y-6">
                <div className="relative">
                  <video
                    ref={modalVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full aspect-video rounded-lg object-cover bg-gray-900"
                    style={{ transform: "scaleX(-1)" }} // Mirror effect
                    onLoadedMetadata={() => {
                      console.log("Modal video metadata loaded", {
                        width: modalVideoRef.current?.videoWidth,
                        height: modalVideoRef.current?.videoHeight,
                        readyState: modalVideoRef.current?.readyState,
                      });
                    }}
                    onCanPlay={() => {
                      console.log("Modal video can play");
                    }}
                  />
                  <div className="absolute inset-0 border-2 border-yellow-500 rounded-lg pointer-events-none" />

                  {/* Video status indicator */}
                  <div className="absolute top-2 right-2 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs">
                    {hasPermission && stream ? (
                      <span className="text-green-400">● Ready</span>
                    ) : (
                      <span className="text-red-400">● Loading...</span>
                    )}
                  </div>
                </div>

                <div className="text-center space-y-4">
                  <p className="text-sm text-gray-600">
                    Position your face in the frame and click capture
                  </p>
                  <Button
                    onClick={capturePhoto}
                    disabled={!hasPermission || isCapturing || !stream}
                    className="w-full bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50"
                  >
                    {isCapturing ? "Capturing..." : "Capture Photo"}
                  </Button>

                  {/* Debug info */}
                  <div className="text-xs text-gray-500 space-y-1">
                    <p>Stream: {stream ? "✅" : "❌"}</p>
                    <p>Permission: {hasPermission ? "✅" : "❌"}</p>
                    <p>
                      Video Element:{" "}
                      {modalVideoRef.current?.srcObject ? "✅" : "❌"}
                    </p>
                    <p>
                      Video Dimensions:{" "}
                      {modalVideoRef.current?.videoWidth || "auto"} x{" "}
                      {modalVideoRef.current?.videoHeight || "auto"}
                    </p>
                  </div>

                  {(!stream || !hasPermission) && (
                    <div className="text-center">
                      <p className="text-xs text-red-500 mb-2">
                        Camera not ready. Let's try again.
                      </p>
                      <Button
                        onClick={getCam}
                        size="sm"
                        className="bg-blue-500 text-white hover:bg-blue-400"
                      >
                        Retry Camera
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Show captured photo */}
                {user.profilePhoto && (
                  <div className="flex flex-col items-center space-y-3">
                    <img
                      src={user.profilePhoto}
                      alt="Profile"
                      className="w-20 h-20 rounded-full object-cover border-2 border-yellow-500"
                      style={{ transform: "scaleX(-1)" }} // Mirror the captured photo too
                    />
                    <Button
                      onClick={() => {
                        setUser((prev) => ({
                          ...prev,
                          profilePhoto: undefined,
                        }));
                        setSetupStep("capture");
                      }}
                      variant="outline"
                      size="sm"
                      className="text-xs border-gray-400 text-gray-600 hover:bg-gray-50"
                    >
                      Retake Photo
                    </Button>
                  </div>
                )}

                {/* Name input */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-black">
                    Your Name
                  </label>
                  <Input
                    type="text"
                    placeholder="Enter your name"
                    value={user.name}
                    onChange={(e) =>
                      setUser((prev) => ({ ...prev, name: e.target.value }))
                    }
                    className="border-gray-300 text-black"
                  />
                </div>

                {/* Topic selection */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-black">
                    Select Topics (Choose at least one)
                  </label>
                  <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                    {topics.map((topic) => (
                      <button
                        key={topic.id}
                        onClick={() => toggleTopic(topic.id)}
                        className={`p-2 text-left text-sm border-2 rounded-lg transition-all text-black ${
                          selectedTopics.includes(topic.id)
                            ? "border-yellow-500 bg-yellow-50"
                            : "border-gray-300 hover:border-gray-400"
                        }`}
                      >
                        <span className="mr-2">{topic.emoji}</span>
                        {topic.name}
                      </button>
                    ))}
                  </div>
                </div>

                <Button
                  onClick={handleStartChatting}
                  disabled={!user.name.trim() || selectedTopics.length === 0}
                  className="w-full bg-yellow-500 text-black hover:bg-yellow-400"
                >
                  Start Chatting
                </Button>
              </div>
            )}
          </div>
        </Modal>
      </div>
    );
  }

  // Chat view
  if (step === "chat") {
    return (
      <Room
        name={user.name}
        localAudioTrack={localAudioTrack}
        localVideoTrack={localVideoTrack}
        profilePhoto={user.profilePhoto}
        language={user.language}
        country={user.country}
        topics={selectedTopics}
        onBackToHome={() => setStep("home")}
      />
    );
  }

  return null;
};
