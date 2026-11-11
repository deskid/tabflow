import React, { useState } from 'react';
import { Globe } from 'lucide-react';

interface FaviconImageProps {
  url?: string;
  favIconUrl?: string;
  size?: number;
  className?: string;
}

export const FaviconImage: React.FC<FaviconImageProps> = ({
  url,
  favIconUrl,
  size = 16,
  className = '',
}) => {
  const [error, setError] = useState(false);

  // Chrome favicon API protocol
  const getChromeFaviconUrl = (targetUrl: string) => {
    if (!chrome?.runtime?.id) return favIconUrl || '';
    const faviconUrl = new URL(`chrome-extension://${chrome.runtime.id}/_favicon/`);
    faviconUrl.searchParams.append('pageUrl', targetUrl);
    faviconUrl.searchParams.append('size', size.toString());
    return faviconUrl.href;
  };

  const finalSrc = url ? getChromeFaviconUrl(url) : favIconUrl;

  if (error || !finalSrc) {
    return (
      <div
        className={`flex items-center justify-center shrink-0 rounded bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 ${className}`}
        style={{ width: size, height: size }}
      >
        <Globe size={Math.max(10, size - 4)} />
      </div>
    );
  }

  return (
    <img
      src={finalSrc}
      alt=""
      width={size}
      height={size}
      onError={() => setError(true)}
      className={`shrink-0 rounded object-contain ${className}`}
      loading="lazy"
    />
  );
};
