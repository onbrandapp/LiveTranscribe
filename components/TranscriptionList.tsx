import React, { useEffect, useRef } from 'react';
import { Speaker, TranscriptEntry } from '../types';

interface TranscriptionListProps {
  transcripts: TranscriptEntry[];
}

const TranscriptionList: React.FC<TranscriptionListProps> = ({ transcripts }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Use scrollIntoView on the bottom anchor for more reliable scrolling
    // especially during rapid streaming updates
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [transcripts]);

  if (transcripts.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-slate-300 dark:text-white/10 uppercase tracking-[0.3em] font-black p-8 text-center transition-colors">
        <svg className="w-12 h-12 mb-4 opacity-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
        </svg>
        Ready for Input
      </div>
    );
  }

  return (
    <div 
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar bg-slate-50/50 dark:bg-matte/40"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="Transcription history"
    >
      {transcripts.map((entry) => {
        const isActive = !entry.isComplete;
        const isModel = entry.speaker === Speaker.MODEL;
        
        // Check for speaker labels (e.g., "Speaker A:")
        const speakerRegex = /^(Speaker [A-Z0-9]+):/i;
        const match = entry.text.match(speakerRegex);
        const displayText = match ? entry.text.replace(speakerRegex, '').trim() : entry.text;
        const speakerLabel = match ? match[1] : null;

        // Logic for side placement:
        // 1. Model is always on the left.
        // 2. Speaker A (primary user) is on the right.
        // 3. Speaker B, C, etc. (secondary users) are on the left to balance the "Interview" feel.
        // 4. Default User (no label) is on the right.
        const isLeft = isModel || (speakerLabel && !speakerLabel.endsWith('A'));

        // Speaker-specific color logic
        const getSpeakerColor = (label: string | null) => {
          if (isModel) return 'bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-900 dark:text-white';
          
          if (!label || label.endsWith('A')) {
            return `bg-banana text-black border-banana ${isActive ? 'bubble-active-user animate-glow-pulse' : 'opacity-95'}`;
          }

          // Assign colors to Speaker B, C, D...
          const colors = [
            'bg-indigo-500 text-white border-indigo-400',
            'bg-emerald-500 text-white border-emerald-400',
            'bg-rose-500 text-white border-rose-400',
            'bg-amber-500 text-white border-amber-400',
            'bg-violet-500 text-white border-violet-400',
          ];
          
          const charCode = label.charCodeAt(label.length - 1);
          const colorIndex = (charCode - 65) % colors.length; // 65 is 'A'
          return `${colors[colorIndex]} ${isActive ? 'animate-glow-pulse' : 'opacity-90'}`;
        };

        const bubbleClasses = getSpeakerColor(speakerLabel);

        return (
          <div 
            key={entry.id}
            className={`flex flex-col transition-all duration-500 ${isLeft ? 'items-start' : 'items-end'} ${isActive ? 'scale-[1.005]' : 'scale-100'}`}
          >
            <div className={`max-w-[85%] rounded-2xl px-5 py-3 text-sm shadow-xl transition-all duration-300 border relative ${
              !isLeft && (!speakerLabel || speakerLabel.endsWith('A'))
                ? bubbleClasses + ' rounded-tr-none'
                : bubbleClasses + ' rounded-tl-none'
            }`}>
              {/* Activity indicator dot for active speaker */}
              {isActive && (
                <div className={`absolute -top-1.5 ${!isLeft ? '-left-1.5' : '-right-1.5'} flex items-center justify-center`}>
                  <span className={`flex h-3 w-3 relative`}>
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${!isLeft ? 'bg-black' : 'bg-white'}`}></span>
                    <span className={`relative inline-flex rounded-full h-3 w-3 ${!isLeft ? 'bg-black' : 'bg-white'}`}></span>
                  </span>
                </div>
              )}

              <div className="space-y-2">
                {speakerLabel && (
                  <span className={`text-[9px] font-black uppercase tracking-tighter px-1.5 py-0.5 rounded-md mb-1 inline-block ${
                    !isLeft && speakerLabel.endsWith('A') 
                      ? 'bg-black/10 text-black/60' 
                      : 'bg-white/20 text-white'
                  }`}>
                    {speakerLabel}
                  </span>
                )}
                <p className={`whitespace-pre-wrap leading-relaxed ${!isLeft ? 'font-bold' : 'font-medium'}`}>
                  {displayText || (
                    <span className="flex gap-1 items-center opacity-40">
                       <span className={`w-1.5 h-1.5 ${!isLeft ? 'bg-black' : 'bg-slate-400 dark:bg-white'} rounded-full animate-bounce`}></span>
                       <span className={`w-1.5 h-1.5 ${!isLeft ? 'bg-black' : 'bg-slate-400 dark:bg-white'} rounded-full animate-bounce [animation-delay:0.2s]`}></span>
                       <span className={`w-1.5 h-1.5 ${!isLeft ? 'bg-black' : 'bg-slate-400 dark:bg-white'} rounded-full animate-bounce [animation-delay:0.4s]`}></span>
                    </span>
                  )}
                </p>

                {entry.translatedText && (
                  <div className={`pt-2 border-t mt-2 ${!isLeft ? 'border-black/10' : 'border-slate-100 dark:border-white/5'}`}>
                    <p className={`text-[11px] font-semibold leading-tight ${
                      !isLeft 
                        ? 'text-black/60' 
                        : 'text-slate-500 dark:text-white/50'
                    }`}>
                      {entry.translatedText}
                    </p>
                  </div>
                )}
              </div>
            </div>
            
            <span className={`text-[9px] font-black mt-2 px-1 uppercase tracking-widest transition-colors duration-500 ${
              isActive 
                ? (!isLeft ? 'text-banana-600 dark:text-banana' : 'text-slate-500 dark:text-white/80') 
                : 'text-slate-400 dark:text-white/20'
            }`}>
              {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              {isActive && <span className="ml-2 animate-pulse">·· processing</span>}
            </span>
          </div>
        );
      })}
      <div ref={bottomRef} className="h-px w-full" />
    </div>
  );
};

export default TranscriptionList;