import React from 'react';
import { WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CONNECTION_QUALITY } from '../lib/utils';

interface ConnectionIndicatorProps {
  quality: keyof typeof CONNECTION_QUALITY;
  className?: string;
  showLabel?: boolean;
}

const LABEL_KEYS = {
  EXCELLENT: 'connection.excellent',
  GOOD: 'connection.good',
  FAIR: 'connection.fair',
  POOR: 'connection.poor',
  DISCONNECTED: 'connection.disconnected',
} as const;

export const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({
  quality,
  className = '',
  showLabel = false
}) => {
  const { t } = useTranslation();
  const qualityInfo = CONNECTION_QUALITY[quality];
  const label = t(LABEL_KEYS[quality]);

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
      <div className={`flex items-center gap-2 ${className}`} role="img" aria-label={t('connection.aria', { label })}>
        <WifiOff className="w-4 h-4 text-red-400" />
        {showLabel && (
          <span className="text-xs text-red-400">{label}</span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`} role="img" aria-label={t('connection.aria', { label })}>
      <div className="flex items-end gap-0.5 h-4">
        {renderBars()}
      </div>
      {showLabel && (
        <span className={`text-xs ${qualityInfo.color}`}>
          {label}
        </span>
      )}
    </div>
  );
};
