import React from 'react';
import { Wifi, WifiOff } from 'lucide-react';
import { CONNECTION_QUALITY } from '../lib/utils';

interface ConnectionIndicatorProps {
  quality: keyof typeof CONNECTION_QUALITY;
  className?: string;
  showLabel?: boolean;
}

export const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({
  quality,
  className = '',
  showLabel = false
}) => {
  const qualityInfo = CONNECTION_QUALITY[quality];

  const renderBars = () => {
    const bars: React.ReactElement[] = [];
    for (let i = 1; i <= 4; i++) {
      bars.push(
        <div
          key={i}
          className={`w-1 rounded-sm ${
            i <= qualityInfo.bars ? qualityInfo.bar : 'bg-gray-600'
          }`}
          style={{ height: `${i * 3 + 2}px` }}
        />
      );
    }
    return bars;
  };

  if (qualityInfo.bars === 0) {
    return (
      <div className={`flex items-center gap-2 ${className}`} role="img" aria-label="Connection: Disconnected">
        <WifiOff className="w-4 h-4 text-red-400" />
        {showLabel && (
          <span className="text-xs text-red-400">Disconnected</span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`} role="img" aria-label={`Connection: ${qualityInfo.label}`}>
      <div className="flex items-end gap-0.5 h-4">
        {renderBars()}
      </div>
      {showLabel && (
        <span className={`text-xs ${qualityInfo.color}`}>
          {qualityInfo.label}
        </span>
      )}
    </div>
  );
}; 