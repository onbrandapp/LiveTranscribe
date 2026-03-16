
import React, { useState, useEffect, useMemo } from 'react';

interface Step {
  id: string;
  title: string;
  content: string;
  targetId?: string;
}

interface OnboardingTourProps {
  onComplete: () => void;
}

const OnboardingTour: React.FC<OnboardingTourProps> = ({ onComplete }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const steps: Step[] = useMemo(() => [
    {
      id: 'welcome',
      title: 'Welcome to Gemini Live',
      content: 'Experience real-time transcription and translation powered by Gemini 2.5 Flash. Let\'s take a quick tour of the core features.',
    },
    {
      id: 'api-key',
      title: 'Set Your API Key',
      content: 'First, ensure you have a Gemini API key set here. Your key is stored locally and securely in your browser.',
      targetId: 'api-key-btn',
    },
    {
      id: 'voice-selection',
      title: 'Choose Your Voice',
      content: 'Select from a variety of professional voices or upload your own audio sample to customize the AI\'s personality.',
      targetId: 'voice-selection',
    },
    {
      id: 'translation',
      title: 'Live Translation',
      content: 'Enable this to translate speech in real-time. You can choose from over 10 supported languages.',
      targetId: 'translation-toggle',
    },
    {
      id: 'start',
      title: 'Start Transcribing',
      content: 'Once you\'re ready, click here to begin your live session. Speak naturally and watch the magic happen!',
      targetId: 'start-session-btn',
    },
  ], []);

  useEffect(() => {
    const step = steps[currentStep];
    if (step.targetId) {
      const element = document.getElementById(step.targetId);
      if (element) {
        setTargetRect(element.getBoundingClientRect());
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        setTargetRect(null);
      }
    } else {
      setTargetRect(null);
    }
  }, [currentStep, steps]);

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      onComplete();
    }
  };

  const handleSkip = () => {
    onComplete();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
      {/* Dimmed Background */}
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-[2px] pointer-events-auto" onClick={handleSkip}></div>
      
      {/* Spotlight Effect */}
      {targetRect && (
        <div 
          className="absolute border-2 border-banana rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.4)] dark:shadow-[0_0_0_9999px_rgba(0,0,0,0.6)] transition-all duration-500 ease-out-back"
          style={{
            top: targetRect.top - 8,
            left: targetRect.left - 8,
            width: targetRect.width + 16,
            height: targetRect.height + 16,
          }}
        ></div>
      )}

      {/* Tooltip Card */}
      <div 
        className={`relative w-[calc(100%-40px)] md:w-full max-w-sm bg-white dark:bg-surface-dark border border-black/5 dark:border-white/10 rounded-[2rem] shadow-2xl p-6 md:p-8 pointer-events-auto transition-all duration-500 ${targetRect ? 'mt-48 md:mt-0' : ''}`}
        style={targetRect ? {
          position: 'absolute',
          top: window.innerWidth < 768 
            ? (targetRect.bottom + 240 > window.innerHeight ? targetRect.top - 280 : targetRect.bottom + 24)
            : (targetRect.bottom + 24 > window.innerHeight - 300 ? targetRect.top - 320 : targetRect.bottom + 24),
          left: window.innerWidth < 768 
            ? 20 
            : Math.max(20, Math.min(window.innerWidth - 380, targetRect.left + targetRect.width / 2 - 192))
        } : {}}
      >
        <div className="flex items-center justify-between mb-4">
          <span className="text-[10px] font-black text-banana uppercase tracking-[0.3em]">Step {currentStep + 1} of {steps.length}</span>
          <button onClick={handleSkip} className="text-[10px] font-bold text-slate-400 dark:text-white/20 uppercase tracking-widest hover:text-red-500 transition-colors">Skip</button>
        </div>
        
        <h3 className="text-lg md:text-xl font-bold text-slate-900 dark:text-white tracking-tight mb-2 md:mb-3">{steps[currentStep].title}</h3>
        <p className="text-xs md:text-sm text-slate-500 dark:text-white/60 leading-relaxed mb-6 md:mb-8">{steps[currentStep].content}</p>
        
        <div className="flex gap-3">
          {currentStep > 0 && (
            <button 
              onClick={() => setCurrentStep(prev => prev - 1)}
              className="flex-1 py-2.5 md:py-3 bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/50 rounded-xl font-bold text-xs tracking-tight hover:bg-slate-200 dark:hover:bg-white/10 transition-all"
            >
              Back
            </button>
          )}
          <button 
            onClick={handleNext}
            className="flex-[2] py-2.5 md:py-3 bg-banana hover:bg-[#EED125] text-black rounded-xl font-bold text-xs tracking-tight shadow-lg shadow-banana/10 transition-all"
          >
            {currentStep === steps.length - 1 ? 'Finish Tour' : 'Next Step'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OnboardingTour;
