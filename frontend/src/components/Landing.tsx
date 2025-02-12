import React, { useState } from "react";
import { useMediaStream } from "../hooks/useMediaStream";
import { Room } from "./Room";

export const Landing: React.FC = () => {
  const [name, setName] = useState<string>("");
  const [joined, setJoined] = useState<boolean>(false);
  const { localAudioTrack, localVideoTrack, videoRef } = useMediaStream();

  if (!joined) {
    return (
      <div className="flex flex-col items-center gap-4">
        <input
          type="text"
          placeholder="Enter your name"
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setName(e.target.value)
          }
          className="px-4 py-2 border rounded"
        />
        <button
          onClick={() => setJoined(true)}
          className="px-4 py-2 bg-blue-500 text-white rounded"
        >
          Join
        </button>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-64 object-cover"
        />
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
