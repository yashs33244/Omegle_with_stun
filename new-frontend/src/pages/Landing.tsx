import React, { useState } from "react";
import { useMediaStream } from "../hooks/useMediaStream";
import { Room } from "./Room";
import { PawPrint, Video, Loader } from "lucide-react";

// Landing Page Component
export const Landing = () => {
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const { localAudioTrack, localVideoTrack, videoRef } = useMediaStream();

  if (!joined) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 p-8">
        <div className="max-w-md mx-auto bg-white rounded-2xl shadow-xl p-8 transform transition-all hover:scale-[1.02]">
          <div className="flex items-center justify-center mb-6 space-x-2">
            <h1 className="text-3xl font-bold bg-gradient-to-r from-purple-600 to-blue-500 bg-clip-text text-transparent">
              Find Your Match
            </h1>
          </div>

          <div className="relative mb-6 rounded-xl overflow-hidden bg-gray-100 aspect-video">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            <div className="absolute bottom-3 right-3">
              <div className="bg-black/30 backdrop-blur-sm text-white px-3 py-1 rounded-full flex items-center space-x-1">
                <Video className="w-4 h-4" />
                <span className="text-sm">Preview</span>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="relative">
              <input
                type="text"
                placeholder="Enter your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-3 rounded-lg border border-gray-200 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all outline-none text-black"
              />
              <PawPrint className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            </div>

            <button
              onClick={() => setJoined(true)}
              disabled={!name.trim()}
              className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white py-3 rounded-lg font-medium
                transform transition-all hover:translate-y-[-2px] hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Start Chatting
            </button>
          </div>

          <p className="text-center text-gray-500 mt-6 text-sm">
            Connect with fellow cat lovers around the world! 🐱
          </p>
        </div>
      </div>
    );
  }

  return (
    <Room
      name={name}
      localAudioTrack={localAudioTrack}
      localVideoTrack={localVideoTrack}
    />
  );
};
