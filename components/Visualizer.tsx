import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  isUserSpeaking: boolean;
  isModelSpeaking: boolean;
  theme: 'light' | 'dark';
  size?: 'default' | 'sm';
}

const Visualizer: React.FC<VisualizerProps> = ({ isActive, isUserSpeaking, isModelSpeaking, theme, size = 'default' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    const isSmall = size === 'sm';
    const bars = isSmall ? 12 : 24;
    const barWidth = isSmall ? 2 : 3;
    const spacing = isSmall ? 3 : 5;
    const heights = new Array(bars).fill(4);

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const totalWidth = bars * (barWidth + spacing);
      const startX = centerX - totalWidth / 2;

      for (let i = 0; i < bars; i++) {
        let multiplier = 1;
        // Pulse effect based on speaker
        if (isUserSpeaking || isModelSpeaking) {
          const distFromCenter = Math.abs(i - bars / 2) / (bars / 2);
          multiplier = 1 - distFromCenter;
        }

        const baseHeight = isActive ? (isUserSpeaking || isModelSpeaking ? (isSmall ? 6 : 12) : 4) : 2;
        const targetHeight = baseHeight + (Math.random() * (isUserSpeaking || isModelSpeaking ? (isSmall ? 20 : 40) : 2) * multiplier);
        
        heights[i] = heights[i] + (targetHeight - heights[i]) * 0.2;

        const x = startX + i * (barWidth + spacing);
        const h = heights[i];
        
        if (isUserSpeaking) {
          ctx.fillStyle = '#FFE135'; // User is Banana Yellow
        } else if (isModelSpeaking) {
          ctx.fillStyle = theme === 'dark' ? '#FFFFFF' : '#0A0A0A'; // Model is themed contrast
        } else {
          ctx.fillStyle = theme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
        }
        
        ctx.beginPath();
        ctx.roundRect(x, centerY - h / 2, barWidth, h, isSmall ? 1 : 2);
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [isActive, isUserSpeaking, isModelSpeaking, theme, size]);

  if (size === 'sm') {
    return (
      <div className="flex items-center justify-center h-8 w-24">
        <canvas 
          ref={canvasRef} 
          width={100} 
          height={32} 
          className="w-full h-full"
          role="img"
          aria-label={isUserSpeaking ? "User is speaking" : isModelSpeaking ? "Gemini is speaking" : "Audio visualizer"}
        />
      </div>
    );
  }

  return (
    <div className="bg-slate-50 dark:bg-surface-dark border border-black/5 dark:border-white/10 rounded-2xl p-5 shadow-sm flex items-center justify-center h-32">
      <canvas 
        ref={canvasRef} 
        width={240} 
        height={80} 
        className="w-full"
        role="img"
        aria-label={isUserSpeaking ? "User is speaking" : isModelSpeaking ? "Gemini is speaking" : "Audio visualizer"}
      />
    </div>
  );
};

export default Visualizer;