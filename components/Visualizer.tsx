import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  isUserSpeaking: boolean;
  isModelSpeaking: boolean;
  theme: 'light' | 'dark';
}

const Visualizer: React.FC<VisualizerProps> = ({ isActive, isUserSpeaking, isModelSpeaking, theme }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    const bars = 24;
    const barWidth = 3;
    const spacing = 5;
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

        const baseHeight = isActive ? (isUserSpeaking || isModelSpeaking ? 12 : 4) : 2;
        const targetHeight = baseHeight + (Math.random() * (isUserSpeaking || isModelSpeaking ? 40 : 2) * multiplier);
        
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
        ctx.roundRect(x, centerY - h / 2, barWidth, h, 2);
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [isActive, isUserSpeaking, isModelSpeaking, theme]);

  return (
    <div className="bg-slate-50 dark:bg-surface-dark border border-black/5 dark:border-white/10 rounded-2xl p-5 shadow-sm flex items-center justify-center h-32">
      <canvas 
        ref={canvasRef} 
        width={240} 
        height={80} 
        className="w-full"
      />
    </div>
  );
};

export default Visualizer;