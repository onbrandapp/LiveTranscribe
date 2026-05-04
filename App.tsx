
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Menu as MenuIcon, 
  X, 
  Sun, 
  Moon, 
  Key, 
  HelpCircle, 
  Play, 
  Pause, 
  Square, 
  Download,
  Trash2,
  Image as ImageIcon,
  ArrowUp,
  Volume2,
  Settings,
  Monitor,
  Keyboard
} from 'lucide-react';
import { Speaker, TranscriptEntry, LiveSessionState, SUPPORTED_LANGUAGES, Language, Voice, AVAILABLE_VOICES } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audio-helpers';
import TranscriptionList from './components/TranscriptionList';
import Visualizer from './components/Visualizer';
import OnboardingTour from './components/OnboardingTour';

const MODEL_NAME = 'gemini-3.1-flash-live-preview';

const App: React.FC = () => {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme');
      if (saved) return saved as 'light' | 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  });

  const [sessionState, setSessionState] = useState<LiveSessionState>({
    isActive: false,
    isPaused: false,
    error: null,
  });

  const [isTranslationEnabled, setIsTranslationEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('gemini_translation_enabled') === 'true';
    }
    return false;
  });

  const [targetLanguage, setTargetLanguage] = useState<Language>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('gemini_target_language');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          return SUPPORTED_LANGUAGES.find(l => l.code === parsed.code) || SUPPORTED_LANGUAGES[0];
        } catch (e) { return SUPPORTED_LANGUAGES[0]; }
      }
    }
    return SUPPORTED_LANGUAGES[0];
  });

  const [customVoices, setCustomVoices] = useState<Voice[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('gemini_custom_voices');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) { return []; }
      }
    }
    return [];
  });

  const [selectedVoice, setSelectedVoice] = useState<Voice>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('gemini_selected_voice');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          // Check prebuilt first
          const prebuilt = AVAILABLE_VOICES.find(v => v.id === parsed.id);
          if (prebuilt) return prebuilt;
          
          // Check custom voices (need to wait for customVoices state but we can try to parse from local storage again here or use the parsed object if it has the data)
          const savedCustom = localStorage.getItem('gemini_custom_voices');
          if (savedCustom) {
            const customList = JSON.parse(savedCustom);
            const custom = customList.find((v: Voice) => v.id === parsed.id);
            if (custom) return custom;
          }
        } catch (e) { return AVAILABLE_VOICES[0]; }
      }
    }
    return AVAILABLE_VOICES[0];
  });

  const [isDrawerRendered, setIsDrawerRendered] = useState(false);
  const [isDrawerClosing, setIsDrawerClosing] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isVoiceLibraryOpen, setIsVoiceLibraryOpen] = useState(false);
  const [showVoiceHelp, setShowVoiceHelp] = useState(false);
  const [showAudioOverlay, setShowAudioOverlay] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('gemini_audio_overlay_enabled') !== 'false';
    }
    return true;
  });

  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('gemini_transcripts');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) { return []; }
      }
    }
    return [];
  });

  const [hotkeys, setHotkeys] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('gemini_hotkeys');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) { /* fallback */ }
      }
    }
    return {
      toggleSession: 'KeyS',
      togglePause: 'KeyP',
      toggleTranslation: 'KeyT',
    };
  });
  const [isHotkeysModalOpen, setIsHotkeysModalOpen] = useState(false);
  const [activeHotkeySetting, setActiveHotkeySetting] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [isImageProcessing, setIsImageProcessing] = useState(false);
  
  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('gemini_api_key');
      return saved || (process.env.GEMINI_API_KEY || process.env.API_KEY || '');
    }
    return '';
  });
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);
  const [tempKey, setTempKey] = useState(apiKey);
  
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [isModelPlaybackPaused, setIsModelPlaybackPaused] = useState(false);

  const [showTour, setShowTour] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('gemini_tour_completed') !== 'true';
    }
    return false;
  });

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const isPausedRef = useRef(false);

  // Buffer refs to accumulate streaming transcription text
  const userTextBuffer = useRef('');
  const modelTextBuffer = useRef('');
  const currentUserSpeaker = useRef<string | null>(null);

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Session Persistence
  useEffect(() => {
    localStorage.setItem('gemini_transcripts', JSON.stringify(transcripts));
  }, [transcripts]);

  useEffect(() => {
    localStorage.setItem('gemini_translation_enabled', String(isTranslationEnabled));
  }, [isTranslationEnabled]);

  useEffect(() => {
    localStorage.setItem('gemini_target_language', JSON.stringify(targetLanguage));
  }, [targetLanguage]);

  useEffect(() => {
    try {
      localStorage.setItem('gemini_selected_voice', JSON.stringify(selectedVoice));
    } catch (e) {
      console.error('Failed to save selected voice:', e);
    }
  }, [selectedVoice]);

  useEffect(() => {
    try {
      localStorage.setItem('gemini_custom_voices', JSON.stringify(customVoices));
    } catch (e) {
      console.error('Failed to save custom voices (likely quota exceeded):', e);
      if (customVoices.length > 0) {
        setSessionState(s => ({ ...s, error: 'Storage full. Try removing some custom voices.' }));
      }
    }
  }, [customVoices]);

  useEffect(() => {
    localStorage.setItem('gemini_audio_overlay_enabled', String(showAudioOverlay));
  }, [showAudioOverlay]);
  
  useEffect(() => {
    localStorage.setItem('gemini_hotkeys', JSON.stringify(hotkeys));
  }, [hotkeys]);

  const [isOverlayVisible, setIsOverlayVisible] = useState(false);

  useEffect(() => {
    if (isModelSpeaking && showAudioOverlay) {
      setIsOverlayVisible(true);
    } else if (!showAudioOverlay) {
      setIsOverlayVisible(false);
    }
  }, [isModelSpeaking, showAudioOverlay]);

  const handleVoiceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('audio/')) {
      setSessionState(s => ({ ...s, error: 'Please upload an audio file.' }));
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setSessionState(s => ({ ...s, error: 'Voice sample too large. Please upload a file under 2MB for browser storage.' }));
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      const newVoice: Voice = {
        id: `custom-${Date.now()}`,
        name: file.name.split('.')[0],
        description: 'Custom uploaded voice sample',
        isCustom: true,
        sampleUrl: base64
      };
      setCustomVoices(prev => [...prev, newVoice]);
      setSelectedVoice(newVoice);
    };
    reader.readAsDataURL(file);
  };

  const removeCustomVoice = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCustomVoices(prev => prev.filter(v => v.id !== id));
    if (selectedVoice.id === id) {
      setSelectedVoice(AVAILABLE_VOICES[0]);
    }
  };

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  const saveApiKey = () => {
    setApiKey(tempKey);
    localStorage.setItem('gemini_api_key', tempKey);
    setIsKeyModalOpen(false);
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !sessionPromiseRef.current) return;

    const textToSend = inputText.trim();
    setInputText('');

    try {
      const session = await sessionPromiseRef.current;
      
      // Manually add the user's text to the transcript feed for immediate feedback
      updateTranscription(Speaker.USER, textToSend, true);
      
      // Send the text content to the Live session
      // Using sendRealtimeInput which is the correct way to send text in Live API
      session.sendRealtimeInput({ 
        text: textToSend
      });
    } catch (err) {
      console.error("Failed to send text input:", err);
      setSessionState(s => ({ ...s, error: 'Failed to send message. Please try again.' }));
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !apiKey) return;

    setIsImageProcessing(true);
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = (reader.result as string).split(',')[1];
        const ai = new GoogleGenAI({ apiKey });
        
        const prompt = isTranslationEnabled 
          ? `Extract all text from this image and translate it into ${targetLanguage.name}. Provide the original text followed by the translation in a clear format.`
          : `Extract all text from this image and provide it in a clear format.`;

        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: {
            parts: [
              { inlineData: { data: base64Data, mimeType: file.type } },
              { text: prompt }
            ]
          }
        });

        const resultText = response.text;
        
        const newEntry: TranscriptEntry = {
          id: Date.now().toString(),
          speaker: Speaker.MODEL,
          text: `[Image Analysis]\n${resultText}`,
          imageUrl: reader.result as string, // Store the base64 URL
          timestamp: Date.now(),
          isComplete: true,
        };
        
        setTranscripts(prev => [...prev, newEntry]);
        setIsImageProcessing(false);
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.error('Image processing error:', error);
      setIsImageProcessing(false);
      setSessionState(prev => ({ ...prev, error: 'Failed to process image. Please check your API key and try again.' }));
    }
  };

  const exportTranscript = () => {
    if (transcripts.length === 0) return;
    
    const content = transcripts.map(entry => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const speaker = entry.speaker === Speaker.MODEL ? 'Gemini' : (entry.speaker === Speaker.USER ? 'User' : 'Unknown');
      
      // Check for internal speaker labels if any
      const speakerRegex = /^(Speaker [A-Z0-9]+):/i;
      const match = entry.text.match(speakerRegex);
      const label = match ? match[1] : speaker;
      const text = match ? entry.text.replace(speakerRegex, '').trim() : entry.text;

      let line = `[${time}] ${label}: ${text}`;
      if (entry.translatedText) {
        line += `\nTranslation (${targetLanguage.name}): ${entry.translatedText}`;
      }
      return line;
    }).join('\n\n');
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const closeDrawer = useCallback(() => {
    setIsDrawerClosing(true);
    setTimeout(() => {
      setIsDrawerRendered(false);
      setIsDrawerClosing(false);
    }, 300);
  }, []);

  const openDrawer = useCallback(() => {
    if (!isTranslationEnabled || sessionState.isActive) return;
    setIsDrawerRendered(true);
  }, [isTranslationEnabled, sessionState.isActive]);

  const updateTranscription = useCallback((speaker: Speaker, text: string, isComplete: boolean) => {
    setTranscripts(prev => {
      const updated = [...prev];
      // Find the last entry for this speaker that is not complete
      let existingIndex = -1;
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].speaker === speaker && !updated[i].isComplete) {
          existingIndex = i;
          break;
        }
      }

      if (existingIndex !== -1) {
        updated[existingIndex] = { ...updated[existingIndex], text, isComplete };
        return updated;
      }

      const newEntry: TranscriptEntry = {
        id: Math.random().toString(36).substring(2, 11),
        speaker,
        text,
        timestamp: Date.now(),
        isComplete
      };
      return [...updated, newEntry];
    });
  }, []);

  const stopSession = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close().catch(() => {});
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close().catch(() => {});
      outputAudioContextRef.current = null;
    }

    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    activeSourcesRef.current.clear();

    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then(session => {
        try { session.close(); } catch(e) {}
      });
      sessionPromiseRef.current = null;
    }

    userTextBuffer.current = '';
    modelTextBuffer.current = '';
    isPausedRef.current = false;
    setSessionState({ isActive: false, isPaused: false, error: null });
    setIsUserSpeaking(false);
    setIsModelSpeaking(false);
    setIsModelPlaybackPaused(false);
  }, []);

  const togglePause = useCallback(() => {
    setSessionState(s => {
      const newPaused = !s.isPaused;
      isPausedRef.current = newPaused;
      if (!newPaused) {
        inputAudioContextRef.current?.resume();
        outputAudioContextRef.current?.resume();
      } else {
        inputAudioContextRef.current?.suspend();
        outputAudioContextRef.current?.suspend();
      }
      return { ...s, isPaused: newPaused };
    });
  }, []);

  const toggleModelPlayback = useCallback(() => {
    if (!outputAudioContextRef.current) return;
    if (isModelPlaybackPaused) {
      outputAudioContextRef.current.resume().catch(() => {});
      setIsModelPlaybackPaused(false);
    } else {
      outputAudioContextRef.current.suspend().catch(() => {});
      setIsModelPlaybackPaused(true);
    }
  }, [isModelPlaybackPaused]);

  const stopModelAudio = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsModelSpeaking(false);
    setIsModelPlaybackPaused(false);
    outputAudioContextRef.current?.resume().catch(() => {});
  }, []);

  const startSession = useCallback(async () => {
    if (!apiKey) {
      setIsKeyModalOpen(true);
      return;
    }
    try {
      const ai = new GoogleGenAI({ apiKey });

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      // Explicitly resume contexts for mobile/Safari support
      await inputCtx.resume();
      await outputCtx.resume();
      
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;
      nextStartTimeRef.current = 0;

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } 
      });
      micStreamRef.current = stream;

      const systemInstruction = (isTranslationEnabled 
        ? `You are a high-fidelity real-time audio translator. 
           Your ONLY job is to translate the user's speech or text input into ${targetLanguage.name}.
           - Provide ONLY the translation in your audio output.
           - Ensure the transcription matches your spoken translation exactly.
           - Include proper punctuation and capitalization.`
        : `You are a helpful and concise AI conversationalist. 
           - Respond naturally and briefly to the user's speech or text input.
           - Ensure all transcriptions include proper punctuation and capitalization.
           - If multiple people are speaking in the user's audio, you MUST distinguish them by prefixing their speech with 'Speaker A:', 'Speaker B:', etc. in the transcription.
           - DO NOT repeat what the user said in your own response unless specifically asked.
           - Your primary goal is to provide useful information while being transcribed in real-time.`) + 
        (selectedVoice.isCustom ? `\n\nNOTE: The user has provided a custom voice sample named "${selectedVoice.name}". While you are currently outputting audio using a prebuilt voice, please attempt to match the tone, cadence, and personality implied by this custom reference.` : '');

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice.isCustom ? 'Zephyr' : selectedVoice.id } },
          },
          systemInstruction,
        },
        callbacks: {
          onopen: () => {
            isPausedRef.current = false;
            setSessionState({ isActive: true, isPaused: false, error: null });
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              if (isPausedRef.current) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const volume = inputData.reduce((a, b) => a + Math.abs(b), 0) / inputData.length;
              setIsUserSpeaking(volume > 0.005);

              const pcmData = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ 
                  audio: { 
                    data: pcmData.data, 
                    mimeType: pcmData.mimeType 
                  } 
                });
              }).catch(() => {});
            };

            source.connect(scriptProcessor);
            scriptProcessor.onended = () => {
              source.disconnect();
              scriptProcessor.disconnect();
            };
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Audio Playback
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              setIsModelSpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputCtx.destination);
              source.onended = () => {
                activeSourcesRef.current.delete(source);
                if (activeSourcesRef.current.size === 0) setIsModelSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              activeSourcesRef.current.add(source);
            }

            // Real-time accumulation of transcription text
            if (message.serverContent?.inputTranscription?.text) {
              const newText = message.serverContent.inputTranscription.text;
              
              // Detect speaker change in user input (e.g. "Speaker A: ...")
              const speakerMatch = newText.match(/^(Speaker [A-Z0-9]+):/i);
              if (speakerMatch) {
                const detectedSpeaker = speakerMatch[1];
                if (currentUserSpeaker.current && currentUserSpeaker.current !== detectedSpeaker) {
                  // Finalize previous speaker's turn
                  updateTranscription(Speaker.USER, userTextBuffer.current, true);
                  userTextBuffer.current = '';
                }
                currentUserSpeaker.current = detectedSpeaker;
              }

              userTextBuffer.current += newText;
              updateTranscription(Speaker.USER, userTextBuffer.current, false);
            }

            if (message.serverContent?.outputTranscription?.text) {
              modelTextBuffer.current += message.serverContent.outputTranscription.text;
              updateTranscription(Speaker.MODEL, modelTextBuffer.current, false);
            }

            if (message.serverContent?.turnComplete) {
              // Finalize current buffers
              if (userTextBuffer.current) updateTranscription(Speaker.USER, userTextBuffer.current, true);
              if (modelTextBuffer.current) updateTranscription(Speaker.MODEL, modelTextBuffer.current, true);
              
              // Reset for next turn
              userTextBuffer.current = '';
              modelTextBuffer.current = '';
              currentUserSpeaker.current = null;
            }

            if (message.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsModelSpeaking(false);
              modelTextBuffer.current = ''; // Clear partial model text if interrupted
            }
          },
          onerror: (err: any) => {
            console.error("Live API Error:", err);
            const errorMsg = err?.message || err?.error?.message || err?.toString() || 'Unknown network error';
            setSessionState(s => ({ ...s, error: `Live API Error: ${errorMsg}` }));
            stopSession();
          },
          onclose: () => {
            stopSession();
          },
        },
      });

      sessionPromiseRef.current = sessionPromise;
    } catch (err: any) {
      setSessionState(s => ({ ...s, error: err.message || 'Microphone access denied.' }));
    }
  }, [apiKey, isTranslationEnabled, targetLanguage, selectedVoice, stopSession, updateTranscription]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea or if a listener for hotkey configuration is active
      if (
        e.target instanceof HTMLInputElement || 
        e.target instanceof HTMLTextAreaElement || 
        (e.target as HTMLElement).isContentEditable ||
        activeHotkeySetting
      ) {
        return;
      }

      if (e.code === hotkeys.toggleSession) {
        e.preventDefault();
        if (sessionState.isActive) stopSession();
        else startSession();
      } else if (e.code === hotkeys.togglePause) {
        e.preventDefault();
        if (sessionState.isActive) togglePause();
      } else if (e.code === hotkeys.toggleTranslation) {
        e.preventDefault();
        setIsTranslationEnabled(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hotkeys, sessionState.isActive, startSession, stopSession, togglePause, activeHotkeySetting]);

  const handleTourComplete = () => {
    setShowTour(false);
    localStorage.setItem('gemini_tour_completed', 'true');
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-3 md:p-4 transition-colors duration-500 bg-white dark:bg-matte selection:bg-banana selection:text-black overflow-x-hidden">
      {showTour && <OnboardingTour onComplete={handleTourComplete} />}
      <header className="w-full max-w-7xl flex items-center justify-between mb-4 border-b border-black/5 dark:border-white/5 pb-4 relative">
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <div className="w-7 h-7 md:w-10 md:h-10 bg-banana rounded-lg md:rounded-xl flex items-center justify-center shadow-lg shadow-banana/20 shrink-0">
            <svg className="w-4 h-4 md:w-6 md:h-6 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="text-sm md:text-xl font-black tracking-tighter text-slate-900 dark:text-white uppercase italic truncate">
              Gemini <span className="text-banana">Live</span>
            </h1>
            <div className="flex items-center gap-1">
              <span className={`w-1 h-1 md:w-1.5 md:h-1.5 rounded-full ${sessionState.isActive ? 'bg-banana animate-pulse' : 'bg-slate-200 dark:bg-white/10'}`}></span>
              <span className="text-[7px] md:text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-widest truncate">
                {sessionState.isActive ? (sessionState.isPaused ? 'Paused' : 'Active') : 'Disconnected'}
              </span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-1 md:gap-3 shrink-0">
          <button 
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className={`p-2 md:p-2.5 bg-slate-100 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-lg md:rounded-xl text-slate-600 dark:text-white/50 hover:bg-slate-200 dark:hover:bg-white/10 transition-all flex items-center gap-2 focus:ring-2 focus:ring-banana/50 outline-none z-[75] ${isMenuOpen ? 'bg-banana/10 border-banana/50 text-banana' : ''}`}
            aria-label="Open Menu"
          >
            <AnimatePresence mode="wait">
              {isMenuOpen ? (
                <motion.div
                  key="close"
                  initial={{ opacity: 0, rotate: -90 }}
                  animate={{ opacity: 1, rotate: 0 }}
                  exit={{ opacity: 0, rotate: 90 }}
                >
                  <X className="w-5 h-5 md:w-6 md:h-6" />
                </motion.div>
              ) : (
                <motion.div
                  key="menu"
                  initial={{ opacity: 0, rotate: 90 }}
                  animate={{ opacity: 1, rotate: 0 }}
                  exit={{ opacity: 0, rotate: -90 }}
                >
                  <MenuIcon className="w-5 h-5 md:w-6 md:h-6" />
                </motion.div>
              )}
            </AnimatePresence>
          </button>

          {/* Navigation Menu Dropdown */}
          <AnimatePresence>
            {isMenuOpen && (
              <>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setIsMenuOpen(false)}
                  className="fixed inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-sm z-[70]"
                />
                <motion.div
                  initial={{ opacity: 0, y: -10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -10, scale: 0.95 }}
                  className="absolute top-16 right-0 w-64 md:w-72 bg-white/90 dark:bg-surface-dark/90 backdrop-blur-2xl border border-black/5 dark:border-white/10 rounded-[2rem] shadow-2xl z-[71] overflow-hidden"
                >
                  <div className="p-2 space-y-1">
                    <button
                      onClick={() => {
                        setTempKey(apiKey);
                        setIsKeyModalOpen(true);
                        setIsMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-3 p-4 hover:bg-slate-50 dark:hover:bg-white/5 rounded-2xl transition-all group"
                    >
                      <div className="w-10 h-10 bg-slate-100 dark:bg-white/10 rounded-xl flex items-center justify-center group-hover:bg-banana/20 group-hover:text-banana transition-colors">
                        <Key className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-bold text-slate-900 dark:text-white">API Settings</p>
                        <p className="text-[10px] text-slate-400 dark:text-white/20 uppercase font-black tracking-widest">Configure Key</p>
                      </div>
                    </button>

                    <button
                      onClick={() => {
                        setShowTour(true);
                        setIsMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-3 p-4 hover:bg-slate-50 dark:hover:bg-white/5 rounded-2xl transition-all group"
                    >
                      <div className="w-10 h-10 bg-slate-100 dark:bg-white/10 rounded-xl flex items-center justify-center group-hover:bg-banana/20 group-hover:text-banana transition-colors">
                        <HelpCircle className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-bold text-slate-900 dark:text-white">App Walkthrough</p>
                        <p className="text-[10px] text-slate-400 dark:text-white/20 uppercase font-black tracking-widest">Restart Tour</p>
                      </div>
                    </button>

                    <button
                      onClick={() => {
                        toggleTheme();
                      }}
                      className="w-full flex items-center gap-3 p-4 hover:bg-slate-50 dark:hover:bg-white/5 rounded-2xl transition-all group"
                    >
                      <div className="w-10 h-10 bg-slate-100 dark:bg-white/10 rounded-xl flex items-center justify-center group-hover:bg-banana/20 group-hover:text-banana transition-colors">
                        {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-bold text-slate-900 dark:text-white">{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</p>
                        <p className="text-[10px] text-slate-400 dark:text-white/20 uppercase font-black tracking-widest">Switch Theme</p>
                      </div>
                    </button>

                    <div className="h-[1px] bg-black/5 dark:bg-white/5 mx-4 my-2" />

                    <button
                      onClick={() => {
                        setIsVoiceLibraryOpen(true);
                        setIsMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-3 p-4 hover:bg-slate-50 dark:hover:bg-white/5 rounded-2xl transition-all group"
                    >
                      <div className="w-10 h-10 bg-slate-100 dark:bg-white/10 rounded-xl flex items-center justify-center group-hover:bg-banana/20 group-hover:text-banana transition-colors">
                        <ImageIcon className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-bold text-slate-900 dark:text-white">Voice Library</p>
                        <p className="text-[10px] text-slate-400 dark:text-white/20 uppercase font-black tracking-widest">Manage Custom</p>
                      </div>
                    </button>

                    <button
                      onClick={() => {
                        setIsHotkeysModalOpen(true);
                        setIsMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-3 p-4 hover:bg-slate-50 dark:hover:bg-white/5 rounded-2xl transition-all group"
                    >
                      <div className="w-10 h-10 bg-slate-100 dark:bg-white/10 rounded-xl flex items-center justify-center group-hover:bg-banana/20 group-hover:text-banana transition-colors">
                        <Keyboard className="w-5 h-5" />
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-bold text-slate-900 dark:text-white">Hotkeys</p>
                        <p className="text-[10px] text-slate-400 dark:text-white/20 uppercase font-black tracking-widest">Keyboard Shortcuts</p>
                      </div>
                    </button>

                    <div className="h-[1px] bg-black/5 dark:bg-white/5 mx-4 my-2" />

                    <div className="px-4 py-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-banana/10 text-banana rounded-xl flex items-center justify-center">
                            <Volume2 className="w-5 h-5" />
                          </div>
                          <div>
                            <p className="text-sm font-bold text-slate-900 dark:text-white">Audio Overlay</p>
                            <p className="text-[10px] text-slate-400 dark:text-white/20 uppercase font-black tracking-widest">Playback Controls</p>
                          </div>
                        </div>
                        <button 
                          onClick={() => setShowAudioOverlay(!showAudioOverlay)}
                          className={`w-10 h-6 rounded-full transition-all relative outline-none ring-offset-2 focus:ring-2 focus:ring-banana/50 ${showAudioOverlay ? 'bg-banana' : 'bg-slate-200 dark:bg-white/10'}`}
                        >
                          <div className={`absolute top-1 w-4 h-4 rounded-full bg-white dark:bg-matte shadow-sm transition-all ${showAudioOverlay ? 'left-5' : 'left-1'}`}></div>
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-400 dark:text-white/30 leading-relaxed italic">
                        Show floating controls when Gemini is speaking.
                      </p>
                    </div>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </header>

      <main className="w-full max-w-7xl flex-1 flex flex-col md:flex-row gap-4 md:gap-6 h-[calc(100vh-140px)] overflow-hidden">
        {/* Controls Column (Desktop) / Top Settings (Mobile) */}
        <div className="w-full md:w-72 flex flex-col gap-4 shrink-0">
          <div className="bg-slate-50 dark:bg-surface-dark border border-black/5 dark:border-white/10 rounded-2xl p-4 md:p-5 shadow-sm space-y-4 md:space-y-5">
            {/* Translation Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-[10px] font-black text-slate-400 dark:text-white/30 uppercase tracking-[0.2em]">Live Translation</label>
                <p className="text-[10px] text-slate-400 dark:text-white/20">Beta Feature</p>
              </div>
              <button 
                id="translation-toggle"
                onClick={() => setIsTranslationEnabled(!isTranslationEnabled)}
                disabled={sessionState.isActive}
                role="switch"
                aria-checked={isTranslationEnabled}
                aria-label="Enable Live Translation"
                className={`w-10 h-6 rounded-full transition-all relative focus:ring-2 focus:ring-banana/50 outline-none ${isTranslationEnabled ? 'bg-banana' : 'bg-slate-200 dark:bg-white/10'} ${sessionState.isActive ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white dark:bg-matte shadow-sm transition-all ${isTranslationEnabled ? 'left-5' : 'left-1'}`}></div>
              </button>
            </div>

            <div className={`${!isTranslationEnabled ? 'opacity-30 grayscale pointer-events-none' : 'opacity-100'} transition-all duration-300`}>
              <label className="block text-[10px] font-black text-slate-400 dark:text-white/30 uppercase mb-2 md:mb-3 tracking-[0.2em]">Translation Target</label>
              <button 
                disabled={!isTranslationEnabled || sessionState.isActive}
                onClick={openDrawer}
                className="w-full flex items-center justify-between bg-white dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-xl p-2.5 md:p-3 text-sm font-bold text-slate-700 dark:text-white hover:border-banana/50 transition-all disabled:opacity-50"
              >
                <span className="flex items-center gap-3">
                  <span className="text-xl">{targetLanguage.flag}</span>
                  <span>{targetLanguage.name}</span>
                </span>
                {!sessionState.isActive && isTranslationEnabled && <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>}
              </button>
            </div>

            {/* Voice Selection */}
            <div id="voice-selection" className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="block text-[10px] font-black text-slate-400 dark:text-white/30 uppercase tracking-[0.2em]">Gemini Voice</label>
                <div className="relative">
                  <input 
                    type="file" 
                    id="voice-upload" 
                    className="hidden" 
                    accept="audio/*"
                    onChange={handleVoiceUpload}
                    disabled={sessionState.isActive}
                  />
                  <label 
                    htmlFor="voice-upload"
                    className={`flex items-center gap-1.5 text-[9px] font-black text-banana uppercase tracking-widest cursor-pointer hover:opacity-80 transition-opacity ${sessionState.isActive ? 'opacity-30 cursor-not-allowed' : ''}`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>
                    Upload
                  </label>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 max-h-[300px] overflow-y-auto custom-scrollbar pr-1">
                {/* Prebuilt Voices */}
                <div className="space-y-2">
                  <p className="text-[8px] font-bold text-slate-400 dark:text-white/20 uppercase tracking-widest">Prebuilt</p>
                  {AVAILABLE_VOICES.map(voice => (
                    <button
                      key={voice.id}
                      disabled={sessionState.isActive}
                      onClick={() => setSelectedVoice(voice)}
                      className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all ${
                        selectedVoice.id === voice.id 
                          ? 'bg-banana/10 border-banana text-slate-900 dark:text-white' 
                          : 'bg-white dark:bg-white/5 border-black/5 dark:border-white/10 text-slate-500 dark:text-white/40 hover:border-banana/30'
                      } ${sessionState.isActive ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <div className="flex items-center justify-between w-full mb-1">
                        <span className="text-xs font-black uppercase tracking-widest">{voice.name}</span>
                        {selectedVoice.id === voice.id && <div className="w-2 h-2 rounded-full bg-banana animate-pulse"></div>}
                      </div>
                      <span className="text-[10px] opacity-60">{voice.description}</span>
                    </button>
                  ))}
                </div>

                {/* Custom Voices */}
                {customVoices.length > 0 && (
                  <div className="space-y-2 pt-2">
                    <p className="text-[8px] font-bold text-slate-400 dark:text-white/20 uppercase tracking-widest">Custom</p>
                    {customVoices.map(voice => (
                      <div
                        key={voice.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => !sessionState.isActive && setSelectedVoice(voice)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            !sessionState.isActive && setSelectedVoice(voice);
                          }
                        }}
                        className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all relative group cursor-pointer ${
                          selectedVoice.id === voice.id 
                            ? 'bg-banana/10 border-banana text-slate-900 dark:text-white' 
                            : 'bg-white dark:bg-white/5 border-black/5 dark:border-white/10 text-slate-500 dark:text-white/40 hover:border-banana/30'
                        } ${sessionState.isActive ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <div className="flex items-center justify-between w-full mb-1">
                          <span className="text-xs font-black uppercase tracking-widest truncate max-w-[120px]">{voice.name}</span>
                          <div className="flex items-center gap-2">
                            {selectedVoice.id === voice.id && <div className="w-2 h-2 rounded-full bg-banana animate-pulse"></div>}
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                removeCustomVoice(voice.id, e);
                              }}
                              className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition-all focus:opacity-100"
                              aria-label={`Remove ${voice.name}`}
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                          </div>
                        </div>
                        <span className="text-[10px] opacity-60">Custom Voice Sample</span>
                      </div>
                    ))}
                  </div>
                )}
                
                {customVoices.length === 0 && (
                  <div className="p-4 border border-dashed border-black/10 dark:border-white/10 rounded-xl flex flex-col items-center justify-center gap-2 opacity-40">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                    <span className="text-[9px] font-bold uppercase tracking-widest">No Custom Voices</span>
                  </div>
                )}
              </div>
              {selectedVoice.isCustom && (
                <div className="p-3 bg-banana/5 border border-banana/20 rounded-xl">
                  <p className="text-[9px] text-banana font-bold leading-tight uppercase tracking-widest">
                    Note: Custom voices are used as reference for the AI's tone. Gemini Live currently defaults to prebuilt voices for audio output.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="hidden md:block flex-1">
            <Visualizer 
              isActive={sessionState.isActive}
              isUserSpeaking={isUserSpeaking}
              isModelSpeaking={isModelSpeaking}
              theme={theme}
            />
          </div>

          {/* Desktop Action Buttons */}
          <div className="hidden md:block mt-auto space-y-3">
            {!sessionState.isActive ? (
              <button 
                id="start-session-btn"
                onClick={startSession}
                className="w-full py-4 bg-banana hover:bg-[#EED125] active:scale-[0.98] transition-all rounded-2xl font-bold text-sm tracking-tight shadow-xl shadow-banana/10 text-black"
              >
                Start Live Transcribe
              </button>
            ) : (
              <div className="flex flex-col gap-3">
                <button 
                  onClick={togglePause}
                  className={`w-full py-4 rounded-2xl font-bold text-sm tracking-tight border-2 transition-all flex items-center justify-center gap-3 ${
                    sessionState.isPaused 
                      ? 'bg-banana border-banana text-black shadow-lg shadow-banana/20' 
                      : 'bg-white dark:bg-white/5 border-black/5 dark:border-white/10 text-slate-700 dark:text-white'
                  }`}
                >
                  {sessionState.isPaused ? (
                    <><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Resume Session</>
                  ) : (
                    <><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Pause Session</>
                  )}
                </button>
                <button 
                  onClick={stopSession}
                  className="w-full py-4 bg-white dark:bg-white/5 border border-red-500/20 text-red-500 rounded-2xl font-bold text-sm tracking-tight hover:bg-red-500/5 transition-all"
                >
                  End Session
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Transcript Feed Column - Main Focus on Mobile */}
        <div className="flex-1 bg-slate-50 dark:bg-surface-dark rounded-3xl border border-black/5 dark:border-white/5 flex flex-col min-h-0 overflow-hidden shadow-2xl relative" role="region" aria-label="Transcription Feed">
          <div className="px-4 md:px-6 py-3 md:py-4 border-b border-black/5 dark:border-white/5 flex justify-between items-center bg-white/80 dark:bg-surface-dark/80 backdrop-blur-xl shrink-0">
            <h2 className="text-[10px] font-black text-slate-400 dark:text-white/50 uppercase tracking-widest md:tracking-[0.4em] truncate mr-2">Transcript Feed</h2>
            <div className="flex items-center gap-2 md:gap-4 shrink-0">
              <div className="hidden lg:flex items-center gap-2 mr-2">
                <span className="px-1.5 py-0.5 bg-slate-100 dark:bg-white/10 border border-black/5 dark:border-white/20 rounded text-[8px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-widest">Space</span>
                <span className="text-[8px] font-bold text-slate-400 dark:text-white/30 uppercase tracking-widest">Start/Pause</span>
              </div>
              <div className="md:hidden">
                <Visualizer 
                  isActive={sessionState.isActive}
                  isUserSpeaking={isUserSpeaking}
                  isModelSpeaking={isModelSpeaking}
                  theme={theme}
                  size="sm"
                />
              </div>
              <button 
                onClick={exportTranscript}
                disabled={transcripts.length === 0}
                className="text-[9px] font-black text-slate-500 dark:text-white/40 hover:text-banana uppercase tracking-widest transition-colors disabled:opacity-20 shrink-0"
              >
                Export
              </button>
              <button 
                onClick={() => setTranscripts([])} 
                disabled={transcripts.length === 0}
                className="text-[9px] font-black text-slate-500 dark:text-white/40 hover:text-red-500 uppercase tracking-widest transition-colors disabled:opacity-20 shrink-0"
              >
                Clear
              </button>
            </div>
          </div>
          <TranscriptionList transcripts={transcripts} />

          <AnimatePresence>
            {showAudioOverlay && isOverlayVisible && (
              <motion.div
                initial={{ opacity: 0, y: 20, x: '-50%', scale: 0.9 }}
                animate={{ opacity: 1, y: 0, x: '-50%', scale: 1 }}
                exit={{ opacity: 0, y: 20, x: '-50%', scale: 0.9 }}
                className="absolute bottom-24 left-1/2 z-[100] flex items-center gap-1.5 bg-white/90 dark:bg-surface-dark/95 backdrop-blur-2xl border border-banana/50 px-4 py-2 rounded-2xl shadow-[0_30px_60px_-12px_rgba(0,0,0,0.4)] ring-1 ring-black/5 dark:ring-white/5"
              >
                <div className="flex items-center gap-0.5">
                  <button 
                    onClick={toggleModelPlayback}
                    className="p-2.5 hover:bg-banana/10 rounded-xl transition-all text-slate-800 dark:text-white group flex items-center justify-center"
                    title={isModelPlaybackPaused ? 'Play AI Audio' : 'Pause AI Audio'}
                  >
                    {isModelPlaybackPaused ? (
                      <Play className="w-5 h-5 fill-current" />
                    ) : (
                      <Pause className="w-5 h-5 fill-current" />
                    )}
                  </button>
                  <button 
                    onClick={stopModelAudio}
                    className="p-2.5 hover:bg-red-500/10 rounded-xl transition-all text-red-500 group flex items-center justify-center"
                    title="Stop AI Audio"
                  >
                    <Square className="w-5 h-5 fill-current" />
                  </button>
                </div>

                <div className="h-6 w-[1px] bg-black/5 dark:bg-white/10 mx-1.5" />

                <div className="flex items-center gap-3 px-1 pr-2">
                  <div className="flex gap-[3px] items-end pb-0.5">
                    {[1, 2, 3, 4].map((i) => (
                      <motion.div
                        key={i}
                        animate={{ height: isModelPlaybackPaused || !isModelSpeaking ? 2 : [4, i * 4 + 4, 4] }}
                        transition={{ repeat: Infinity, duration: 0.6, delay: i * 0.1 }}
                        className="w-[3px] bg-banana rounded-full shadow-[0_0_8px_rgba(238,209,37,0.4)]"
                      />
                    ))}
                  </div>
                  <div className="flex flex-col min-w-[70px]">
                    <span className="text-[10px] font-black uppercase tracking-[0.1em] text-banana drop-shadow-sm">
                      {isModelPlaybackPaused ? 'AI Paused' : (isModelSpeaking ? 'AI Speaking' : 'AI Finished')}
                    </span>
                    <span className="text-[7px] font-bold text-slate-400 dark:text-white/30 uppercase tracking-[0.25em] -mt-0.5">
                      Live Output
                    </span>
                  </div>
                </div>

                <div className="h-6 w-[1px] bg-black/5 dark:bg-white/10 mx-1.5" />

                <button 
                  onClick={() => setIsOverlayVisible(false)}
                  className="p-1.5 hover:bg-slate-100 dark:hover:bg-white/10 rounded-lg text-slate-400 dark:text-white/30 hover:text-slate-600 dark:hover:text-white transition-all"
                  aria-label="Dismiss Overlay"
                >
                  <X className="w-4 h-4" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          
          {/* Keyboard Input Bar */}
          <div className="p-3 md:p-4 border-t border-black/5 dark:border-white/5 bg-white/50 dark:bg-surface-dark/50 backdrop-blur-xl shrink-0">
            <form onSubmit={handleTextSubmit} className="relative flex items-center gap-2">
              <label id="image-upload-btn" className="p-2 text-slate-400 hover:text-banana transition-colors cursor-pointer disabled:opacity-50 focus-within:ring-2 focus-within:ring-banana/50 rounded-xl outline-none" aria-label="Upload image for translation">
                <input 
                  type="file" 
                  accept="image/*" 
                  className="hidden" 
                  onChange={handleImageUpload}
                  disabled={isImageProcessing}
                />
                {isImageProcessing ? (
                  <div className="w-5 h-5 border-2 border-banana border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                )}
              </label>
              <input 
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={isTranslationEnabled ? `Translate to ${targetLanguage.name}...` : "Type a message..."}
                disabled={!sessionState.isActive}
                aria-label={isTranslationEnabled ? `Translate to ${targetLanguage.name}` : "Type a message to Gemini"}
                className="w-full bg-slate-100 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-2xl p-3.5 md:p-4 pr-12 text-sm font-medium text-slate-900 dark:text-white focus:ring-2 focus:ring-banana/50 focus:border-banana outline-none transition-all disabled:opacity-50 placeholder:text-slate-400 dark:placeholder:text-white/20"
              />
              <button 
                type="submit"
                disabled={!sessionState.isActive || !inputText.trim()}
                aria-label="Send message"
                className="absolute right-2 p-2 bg-banana text-black rounded-xl shadow-lg shadow-banana/20 hover:scale-105 active:scale-95 transition-all disabled:opacity-0 disabled:scale-90 focus:ring-2 focus:ring-banana/50 outline-none"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              </button>
            </form>
          </div>
        </div>

        {/* Mobile Action Buttons - Sticky at bottom */}
        <div className="md:hidden pt-2 pb-4 shrink-0">
          {!sessionState.isActive ? (
            <button 
              onClick={startSession}
              aria-label="Start Live Transcribe Session"
              className="w-full py-4 bg-banana hover:bg-[#EED125] active:scale-[0.98] transition-all rounded-2xl font-bold text-sm tracking-tight shadow-xl shadow-banana/10 text-black focus:ring-4 focus:ring-banana/50 outline-none"
            >
              Start Live Transcribe
            </button>
          ) : (
            <div className="flex gap-3">
              <button 
                onClick={togglePause}
                aria-label={sessionState.isPaused ? "Resume Session" : "Pause Session"}
                className={`flex-1 py-4 rounded-2xl font-bold text-xs tracking-tight border-2 transition-all flex items-center justify-center gap-2 focus:ring-4 focus:ring-banana/50 outline-none ${
                  sessionState.isPaused 
                    ? 'bg-banana border-banana text-black shadow-lg shadow-banana/20' 
                    : 'bg-white dark:bg-white/5 border-black/5 dark:border-white/10 text-slate-700 dark:text-white'
                }`}
              >
                {sessionState.isPaused ? (
                  <><svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Resume</>
                ) : (
                  <><svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Pause</>
                )}
              </button>
              <button 
                onClick={stopSession}
                aria-label="End Session"
                className="flex-1 py-4 bg-white dark:bg-white/5 border border-red-500/20 text-red-500 rounded-2xl font-bold text-xs tracking-tight hover:bg-red-500/5 transition-all focus:ring-4 focus:ring-red-500/50 outline-none"
              >
                End Session
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Language Modal */}
      {isDrawerRendered && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4" role="dialog" aria-modal="true" aria-labelledby="language-modal-title">
          <div className={`absolute inset-0 bg-black/40 dark:bg-black/60 overlay-blur ${isDrawerClosing ? 'animate-fade-out' : 'animate-fade-in'}`} onClick={closeDrawer}></div>
          <div className={`relative w-full max-w-lg bg-white/90 dark:bg-surface-dark/90 backdrop-blur-2xl border-t md:border border-black/5 dark:border-white/10 rounded-t-[2.5rem] md:rounded-[2.5rem] shadow-2xl p-6 md:p-8 ${isDrawerClosing ? 'animate-slide-down' : 'animate-slide-up'}`}>
            {/* Handle for mobile */}
            <div className="w-12 h-1.5 bg-slate-200 dark:bg-white/10 rounded-full mx-auto mb-6 md:hidden"></div>
            
            <div className="flex items-center justify-between mb-8">
              <h3 id="language-modal-title" className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Translation Target</h3>
              <button 
                onClick={closeDrawer}
                aria-label="Close modal"
                className="p-2 bg-slate-100 dark:bg-white/5 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors focus:ring-2 focus:ring-banana/50 outline-none"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 max-h-[50vh] md:max-h-[60vh] overflow-y-auto custom-scrollbar pr-2">
              {SUPPORTED_LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => { setTargetLanguage(lang); closeDrawer(); }}
                  className={`group flex items-center justify-between p-4 rounded-2xl border transition-all duration-300 ${
                    targetLanguage.code === lang.code 
                      ? 'bg-banana border-banana shadow-lg shadow-banana/20' 
                      : 'bg-slate-50/50 dark:bg-white/5 border-transparent hover:border-slate-200 dark:hover:border-white/10 hover:bg-white dark:hover:bg-white/[0.08]'
                  }`}
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <span className="text-2xl shrink-0">{lang.flag}</span>
                    <span className={`text-xs font-bold tracking-tight truncate ${
                      targetLanguage.code === lang.code ? 'text-black' : 'text-slate-600 dark:text-white/70'
                    }`}>
                      {lang.name}
                    </span>
                  </div>
                  {targetLanguage.code === lang.code && (
                    <svg className="w-4 h-4 text-black shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Voice Library Modal */}
      <AnimatePresence>
        {isVoiceLibraryOpen && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="dialog" aria-modal="true">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/60 dark:bg-black/80 backdrop-blur-md" 
              onClick={() => setIsVoiceLibraryOpen(false)}
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-white dark:bg-surface-dark border border-black/5 dark:border-white/10 rounded-[2.5rem] shadow-2xl overflow-hidden"
            >
              <div className="p-8 border-b border-black/5 dark:border-white/5 flex items-center justify-between">
                <div>
                  <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tighter uppercase italic">Voice <span className="text-banana">Library</span></h3>
                  <p className="text-xs text-slate-400 dark:text-white/20 font-bold uppercase tracking-widest mt-1">Manage your custom AI references</p>
                </div>
                <button 
                  onClick={() => setIsVoiceLibraryOpen(false)}
                  className="p-3 bg-slate-100 dark:bg-white/5 rounded-full text-slate-400 hover:text-slate-900 dark:hover:text-white transition-all transform hover:rotate-90"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="p-8 max-h-[60vh] overflow-y-auto custom-scrollbar">
                {customVoices.length === 0 ? (
                  <div className="py-12 flex flex-col items-center justify-center text-center space-y-4 opacity-40">
                    <div className="w-20 h-20 bg-slate-100 dark:bg-white/5 rounded-full flex items-center justify-center">
                      <Volume2 className="w-10 h-10" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-900 dark:text-white">No Custom Voices Yet</p>
                      <p className="text-xs text-slate-400 dark:text-white/40 mt-1 max-w-[200px]">Upload an audio sample in the main sidebar to get started.</p>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {customVoices.map(voice => (
                      <div 
                        key={voice.id}
                        className={`p-5 rounded-3xl border transition-all duration-300 flex flex-col gap-4 group ${
                          selectedVoice.id === voice.id 
                            ? 'bg-banana/10 border-banana shadow-xl shadow-banana/5' 
                            : 'bg-slate-50/50 dark:bg-white/5 border-transparent hover:border-banana/30'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="min-w-0">
                            <p className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-widest truncate">{voice.name}</p>
                            <p className="text-[10px] text-slate-400 dark:text-white/30 truncate mt-0.5">Reference Sample</p>
                          </div>
                          <div className="flex items-center gap-1">
                            <button 
                              onClick={() => {
                                const audio = new Audio(voice.sampleUrl);
                                audio.play().catch(console.error);
                              }}
                              className="p-2 bg-white dark:bg-white/10 rounded-xl text-slate-400 hover:text-banana dark:hover:text-banana transition-all shadow-sm"
                              title="Play Sample"
                            >
                              <Play className="w-4 h-4 fill-current" />
                            </button>
                            <button 
                              onClick={(e) => removeCustomVoice(voice.id, e)}
                              className="p-2 bg-white dark:bg-white/10 rounded-xl text-slate-400 hover:text-red-500 transition-all shadow-sm"
                              title="Delete Voice"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        <button
                          onClick={() => {
                            if (!sessionState.isActive) {
                              setSelectedVoice(voice);
                              setIsVoiceLibraryOpen(false);
                            }
                          }}
                          disabled={sessionState.isActive}
                          className={`w-full py-3 rounded-2xl font-bold text-[10px] uppercase tracking-widest transition-all ${
                            selectedVoice.id === voice.id
                              ? 'bg-banana text-black'
                              : 'bg-white dark:bg-white/10 text-slate-600 dark:text-white/50 hover:bg-banana/20 hover:text-banana'
                          } disabled:opacity-50`}
                        >
                          {selectedVoice.id === voice.id ? 'Currently Active' : 'Set as Reference'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-8 p-6 bg-slate-50 dark:bg-white/5 rounded-[2rem] border border-black/5 dark:border-white/5 group-hover:border-banana/20 transition-all">
                  <button 
                    onClick={() => setShowVoiceHelp(!showVoiceHelp)}
                    className="flex items-center justify-between w-full text-left outline-none"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all ${showVoiceHelp ? 'bg-banana text-black' : 'bg-slate-100 dark:bg-white/10 text-slate-400'}`}>
                        <HelpCircle className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-900 dark:text-white">What is an AI Reference?</p>
                        <p className="text-[8px] text-slate-400 dark:text-white/20 uppercase font-bold tracking-tighter">Understanding custom voices</p>
                      </div>
                    </div>
                    <motion.div
                      animate={{ rotate: showVoiceHelp ? 180 : 0 }}
                      className="text-slate-400"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                      </svg>
                    </motion.div>
                  </button>
                  <AnimatePresence>
                    {showVoiceHelp && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="pt-6 space-y-4">
                          <div className="h-[1px] bg-black/5 dark:bg-white/5 w-full" />
                          <p className="text-[11px] text-slate-500 dark:text-white/40 leading-relaxed italic">
                            Uploading a custom voice tells Gemini to use your audio as a <span className="text-banana font-bold">Stylistic Blueprint</span>.
                          </p>
                          <p className="text-[11px] text-slate-500 dark:text-white/40 leading-relaxed">
                            Rather than simply playing back a recording, Gemini analyzes the pitch, resonance, and unique characteristics of your sample. It then synthesizes its own responses to <span className="text-slate-900 dark:text-white font-bold tracking-tight text-[10px] italic">mimic the persona</span> you've provided.
                          </p>
                          <div className="grid grid-cols-2 gap-4 pt-2">
                            <div className="flex flex-col gap-1">
                              <p className="text-[9px] font-black text-banana uppercase">Usage</p>
                              <p className="text-[10px] text-slate-400">Works in both Chat and Live Translation modes.</p>
                            </div>
                            <div className="flex flex-col gap-1">
                              <p className="text-[9px] font-black text-banana uppercase">Privacy</p>
                              <p className="text-[10px] text-slate-400">Voices are stored only on your device.</p>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              <div className="p-8 bg-slate-50 dark:bg-white/5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-banana/20 rounded-lg flex items-center justify-center">
                    <Monitor className="w-4 h-4 text-banana" />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-slate-900 dark:text-white uppercase tracking-widest">Storage Status</p>
                    <p className="text-[9px] text-slate-400 dark:text-white/20">Saved in your local browser session</p>
                  </div>
                </div>
                {customVoices.length > 0 && (
                  <button 
                    onClick={() => {
                      if (confirm('Are you sure you want to delete all custom voices?')) {
                        setCustomVoices([]);
                        if (selectedVoice.isCustom) setSelectedVoice(AVAILABLE_VOICES[0]);
                      }
                    }}
                    className="px-4 py-2 text-[10px] font-bold text-red-500 hover:bg-red-500/10 rounded-xl transition-all uppercase tracking-widest"
                  >
                    Clear All
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
          {/* Hotkeys Modal */}
      <AnimatePresence>
        {isHotkeysModalOpen && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="dialog" aria-modal="true">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/60 dark:bg-black/80 backdrop-blur-md" 
              onClick={() => setIsHotkeysModalOpen(false)}
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-lg bg-white dark:bg-surface-dark border border-black/5 dark:border-white/10 rounded-[2.5rem] shadow-2xl overflow-hidden"
            >
              <div className="p-8 border-b border-black/5 dark:border-white/5 flex items-center justify-between">
                <div>
                  <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tighter uppercase italic">Keyboard <span className="text-banana">Shortcuts</span></h3>
                  <p className="text-xs text-slate-400 dark:text-white/20 font-bold uppercase tracking-widest mt-1">Configure your hotkeys</p>
                </div>
                <button 
                  onClick={() => setIsHotkeysModalOpen(false)}
                  className="p-3 bg-slate-100 dark:bg-white/5 rounded-full text-slate-400 hover:text-slate-900 dark:hover:text-white transition-all transform hover:rotate-90"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="p-8 space-y-6">
                <div className="space-y-4">
                  {[
                    { key: 'toggleSession', label: 'Start/Stop Session', icon: Play },
                    { key: 'togglePause', label: 'Pause/Resume AI', icon: Pause },
                    { key: 'toggleTranslation', label: 'Toggle Translation', icon: Volume2 }
                  ].map((setting) => (
                    <div key={setting.key} className="flex items-center justify-between group">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-400 group-hover:text-banana transition-colors">
                          <setting.icon className="w-4 h-4" />
                        </div>
                        <p className="text-sm font-bold text-slate-700 dark:text-white/80">{setting.label}</p>
                      </div>
                      <button
                        onClick={() => activeHotkeySetting === setting.key ? setActiveHotkeySetting(null) : setActiveHotkeySetting(setting.key)}
                        className={`min-w-[100px] h-10 rounded-xl border font-mono text-[10px] font-black uppercase tracking-widest transition-all ${
                          activeHotkeySetting === setting.key
                            ? 'bg-banana/20 border-banana text-banana shadow-[0_0_15px_rgba(238,209,37,0.2)]'
                            : 'bg-slate-50 dark:bg-white/5 border-transparent text-slate-400 dark:text-white/20 hover:border-banana/50 hover:text-banana'
                        }`}
                      >
                        {activeHotkeySetting === setting.key ? (
                          <motion.span
                            animate={{ opacity: [1, 0.5, 1] }}
                            transition={{ repeat: Infinity, duration: 1 }}
                          >
                            Press Any Key...
                          </motion.span>
                        ) : (
                          hotkeys[setting.key].replace('Key', '')
                        )}
                      </button>
                    </div>
                  ))}
                </div>

                {activeHotkeySetting && (
                  <div 
                    tabIndex={0} 
                    autoFocus
                    onKeyDown={(e) => {
                      e.preventDefault();
                      setHotkeys(prev => ({ ...prev, [activeHotkeySetting!]: e.code }));
                      setActiveHotkeySetting(null);
                    }}
                    className="fixed inset-0 z-[-1]"
                  />
                )}

                <div className="p-4 bg-slate-50 dark:bg-white/5 rounded-2xl">
                  <p className="text-[10px] text-slate-400 dark:text-white/20 leading-relaxed italic text-center">
                    Click a hotkey button and press a new key to reassign it.
                  </p>
                </div>
              </div>

              <div className="p-8 bg-slate-50 dark:bg-white/5 flex items-center justify-center">
                <button 
                  onClick={() => setHotkeys({ toggleSession: 'KeyS', togglePause: 'KeyP', toggleTranslation: 'KeyT' })}
                  className="px-6 py-2 text-[10px] font-bold text-slate-400 hover:text-banana transition-all uppercase tracking-widest"
                >
                  Reset to Defaults
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {isKeyModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="api-modal-title">
          <div className="absolute inset-0 bg-black/60 dark:bg-black/80 overlay-blur animate-fade-in" onClick={() => setIsKeyModalOpen(false)}></div>
          <div className="relative w-full max-w-md bg-white dark:bg-surface-dark border border-black/5 dark:border-white/10 rounded-3xl shadow-2xl p-8 animate-slide-up">
            <div className="flex items-center justify-between mb-8">
              <h3 id="api-modal-title" className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">API Settings</h3>
              <button 
                onClick={() => setIsKeyModalOpen(false)}
                aria-label="Close modal"
                className="p-2 bg-slate-100 dark:bg-white/5 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors focus:ring-2 focus:ring-banana/50 outline-none"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-black text-slate-400 dark:text-white/30 uppercase mb-2 tracking-[0.2em]">Gemini API Key</label>
                <input 
                  type="password"
                  value={tempKey}
                  onChange={(e) => setTempKey(e.target.value)}
                  placeholder="Enter your API key..."
                  className="w-full bg-slate-50 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-xl p-4 text-sm font-medium text-slate-900 dark:text-white focus:ring-2 focus:ring-banana/50 focus:border-banana outline-none transition-all"
                />
                <p className="mt-2 text-[10px] text-slate-400 dark:text-white/20 leading-relaxed">
                  Your key is stored locally in your browser and never sent to our servers. 
                  Get one at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-banana hover:underline">Google AI Studio</a>.
                </p>
              </div>
              
              <div className="flex gap-3 pt-4">
                <button 
                  onClick={() => setIsKeyModalOpen(false)}
                  className="flex-1 py-4 bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/50 rounded-2xl font-bold text-xs tracking-tight hover:bg-slate-200 dark:hover:bg-white/10 transition-all"
                >
                  Cancel
                </button>
                <button 
                  onClick={saveApiKey}
                  className="flex-1 py-4 bg-banana hover:bg-[#EED125] text-black rounded-2xl font-bold text-xs tracking-tight shadow-lg shadow-banana/10 transition-all"
                >
                  Save Key
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {sessionState.error && (
        <div className="fixed bottom-8 px-6 py-3 bg-red-500 text-white text-[10px] font-black uppercase tracking-widest rounded-full shadow-2xl animate-bounce">
          {sessionState.error}
        </div>
      )}
    </div>
  );
};

export default App;
