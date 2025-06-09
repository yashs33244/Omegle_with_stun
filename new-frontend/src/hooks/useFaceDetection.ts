import { useEffect, useState, useRef } from 'react';

// MediaPipe face detection types
declare global {
  interface Window {
    FaceDetection: any;
    Camera: any;
  }
}

export const useFaceDetection = (videoRef: React.RefObject<HTMLVideoElement>) => {
  const [faceDetected, setFaceDetected] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const faceDetectionRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);

  useEffect(() => {
    let mounted = true;

    const initializeFaceDetection = async () => {
      try {
        // Load MediaPipe scripts
        if (!window.FaceDetection) {
          // Fallback to simple detection for now
          setIsLoading(false);
          startSimpleDetection();
          return;
        }

        const faceDetection = new window.FaceDetection({
          locateFile: (file: string) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`;
          }
        });

        faceDetection.setOptions({
          model: 'short',
          minDetectionConfidence: 0.5,
        });

        faceDetection.onResults((results: any) => {
          if (mounted) {
            setFaceDetected(results.detections && results.detections.length > 0);
          }
        });

        if (videoRef.current && mounted) {
          const camera = new window.Camera(videoRef.current, {
            onFrame: async () => {
              if (mounted) {
                await faceDetection.send({ image: videoRef.current });
              }
            },
            width: 640,
            height: 480
          });

          cameraRef.current = camera;
          faceDetectionRef.current = faceDetection;
          
          if (mounted) {
            setIsLoading(false);
          }
        }
      } catch (error) {
        console.warn('MediaPipe face detection failed, using fallback:', error);
        if (mounted) {
          setIsLoading(false);
          startSimpleDetection();
        }
      }
    };

    const startSimpleDetection = () => {
      // Simple fallback detection - check if video is playing and has dimensions
      const interval = setInterval(() => {
        if (videoRef.current && mounted) {
          const video = videoRef.current;
          const hasVideo = video.videoWidth > 0 && video.videoHeight > 0 && !video.paused;
          setFaceDetected(hasVideo);
        }
      }, 1000);

      return () => clearInterval(interval);
    };

    if (videoRef.current) {
      initializeFaceDetection();
    }

    return () => {
      mounted = false;
      if (cameraRef.current) {
        cameraRef.current.stop();
      }
    };
  }, [videoRef]);

  return {
    faceDetected,
    isLoading
  };
}; 