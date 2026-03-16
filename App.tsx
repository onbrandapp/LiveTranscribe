
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Speaker, TranscriptEntry, LiveSessionState, SUPPORTED_LANGUAGES, Language, Voice, AVAILABLE_VOICES } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audio-helpers';
import TranscriptionList from './components/TranscriptionList';
import Visualizer from './components/Visualizer';
import OnboardingTour from './components/OnboardingTour';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

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
  const [inputText, setInputText] = useState('');
  
  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('gemini_api_key');
      return saved || (process.env.API_KEY || '');
    }
    return '';
  });
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);
  const [tempKey, setTempKey] = useState(apiKey);
  
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);

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
    localStorage.setItem('gemini_selected_voice', JSON.stringify(selectedVoice));
  }, [selectedVoice]);

  useEffect(() => {
    localStorage.setItem('gemini_custom_voices', JSON.stringify(customVoices));
  }, [customVoices]);

  const handleVoiceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('audio/')) {
      setSessionState(s => ({ ...s, error: 'Please upload an audio file.' }));
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
      // Using sendClientContent which is the correct way to send text turns in Live API
      session.sendClientContent({ 
        turns: [{ role: 'user', parts: [{ text: textToSend }] }],
        turnComplete: true 
      });
    } catch (err) {
      console.error("Failed to send text input:", err);
      setSessionState(s => ({ ...s, error: 'Failed to send message. Please try again.' }));
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
  }, []);

  const startSession = async () => {
    if (!apiKey) {
      setIsKeyModalOpen(true);
      return;
    }
    try {
      const ai = new GoogleGenAI({ apiKey });

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
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
          inputAudioTranscription: {},
          outputAudioTranscription: {},
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

              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(() => {});
            };

            source.connect(scriptProcessor);
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
          onerror: (err) => {
            console.error("Live API Error:", err);
            setSessionState(s => ({ ...s, error: 'Connection lost. Reconnecting...' }));
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
  };

  const togglePause = () => {
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
  };

  const handleTourComplete = () => {
    setShowTour(false);
    localStorage.setItem('gemini_tour_completed', 'true');
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-3 md:p-4 transition-colors duration-500 bg-white dark:bg-matte selection:bg-banana selection:text-black overflow-x-hidden">
      {showTour && <OnboardingTour onComplete={handleTourComplete} />}
      <header className="w-full max-w-7xl flex items-center justify-between mb-4 border-b border-black/5 dark:border-white/5 pb-4">
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
            id="api-key-btn"
            onClick={() => {
              setTempKey(apiKey);
              setIsKeyModalOpen(true);
            }}
            className="p-1.5 md:p-2.5 bg-slate-100 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-lg md:rounded-xl text-slate-600 dark:text-white/50 hover:bg-slate-200 dark:hover:bg-white/10 transition-all flex items-center gap-2"
            title="API Settings"
          >
            <svg className="w-3.5 h-3.5 md:w-5 md:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </button>
          <button 
            onClick={() => setShowTour(true)}
            className="p-1.5 md:p-2.5 bg-slate-100 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-lg md:rounded-xl text-slate-600 dark:text-white/50 hover:bg-slate-200 dark:hover:bg-white/10 transition-all"
            title="Show Tour"
          >
            <svg className="w-3.5 h-3.5 md:w-5 md:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <button 
            onClick={toggleTheme}
            className="p-1.5 md:p-2.5 bg-slate-100 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-lg md:rounded-xl text-slate-600 dark:text-white/50 hover:bg-slate-200 dark:hover:bg-white/10 transition-all"
          >
            {theme === 'dark' ? (
              <svg className="w-3.5 h-3.5 md:w-5 md:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M14 12a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
            ) : (
              <svg className="w-3.5 h-3.5 md:w-5 md:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
            )}
          </button>
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
                className={`w-10 h-6 rounded-full transition-all relative ${isTranslationEnabled ? 'bg-banana' : 'bg-slate-200 dark:bg-white/10'} ${sessionState.isActive ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                      <button
                        key={voice.id}
                        disabled={sessionState.isActive}
                        onClick={() => setSelectedVoice(voice)}
                        className={`w-full flex flex-col items-start p-3 rounded-xl border transition-all relative group ${
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
                              onClick={(e) => removeCustomVoice(voice.id, e)}
                              className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition-all"
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                          </div>
                        </div>
                        <span className="text-[10px] opacity-60">Custom Voice Sample</span>
                      </button>
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
        <div className="flex-1 bg-slate-50 dark:bg-surface-dark rounded-3xl border border-black/5 dark:border-white/5 flex flex-col min-h-0 overflow-hidden shadow-2xl relative">
          <div className="px-4 md:px-6 py-3 md:py-4 border-b border-black/5 dark:border-white/5 flex justify-between items-center bg-white/80 dark:bg-surface-dark/80 backdrop-blur-xl shrink-0">
            <h2 className="text-[10px] font-black text-slate-400 dark:text-white/40 uppercase tracking-widest md:tracking-[0.4em] truncate mr-2">Transcript Feed</h2>
            <div className="flex items-center gap-2 md:gap-4 shrink-0">
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
          
          {/* Keyboard Input Bar */}
          <div className="p-3 md:p-4 border-t border-black/5 dark:border-white/5 bg-white/50 dark:bg-surface-dark/50 backdrop-blur-xl shrink-0">
            <form onSubmit={handleTextSubmit} className="relative flex items-center gap-2">
              <input 
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={isTranslationEnabled ? `Translate to ${targetLanguage.name}...` : "Type a message..."}
                disabled={!sessionState.isActive}
                className="w-full bg-slate-100 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-2xl p-3.5 md:p-4 pr-12 text-sm font-medium text-slate-900 dark:text-white focus:ring-2 focus:ring-banana/50 focus:border-banana outline-none transition-all disabled:opacity-50 placeholder:text-slate-400 dark:placeholder:text-white/20"
              />
              <button 
                type="submit"
                disabled={!sessionState.isActive || !inputText.trim()}
                className="absolute right-2 p-2 bg-banana text-black rounded-xl shadow-lg shadow-banana/20 hover:scale-105 active:scale-95 transition-all disabled:opacity-0 disabled:scale-90"
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
              className="w-full py-4 bg-banana hover:bg-[#EED125] active:scale-[0.98] transition-all rounded-2xl font-bold text-sm tracking-tight shadow-xl shadow-banana/10 text-black"
            >
              Start Live Transcribe
            </button>
          ) : (
            <div className="flex gap-3">
              <button 
                onClick={togglePause}
                className={`flex-1 py-4 rounded-2xl font-bold text-xs tracking-tight border-2 transition-all flex items-center justify-center gap-2 ${
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
                className="flex-1 py-4 bg-white dark:bg-white/5 border border-red-500/20 text-red-500 rounded-2xl font-bold text-xs tracking-tight hover:bg-red-500/5 transition-all"
              >
                End Session
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Language Modal */}
      {isDrawerRendered && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
          <div className={`absolute inset-0 bg-black/40 dark:bg-black/60 overlay-blur ${isDrawerClosing ? 'animate-fade-out' : 'animate-fade-in'}`} onClick={closeDrawer}></div>
          <div className={`relative w-full max-w-lg bg-white/90 dark:bg-surface-dark/90 backdrop-blur-2xl border-t md:border border-black/5 dark:border-white/10 rounded-t-[2.5rem] md:rounded-[2.5rem] shadow-2xl p-6 md:p-8 ${isDrawerClosing ? 'animate-slide-down' : 'animate-slide-up'}`}>
            {/* Handle for mobile */}
            <div className="w-12 h-1.5 bg-slate-200 dark:bg-white/10 rounded-full mx-auto mb-6 md:hidden"></div>
            
            <div className="flex items-center justify-between mb-8">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Translation Target</h3>
              <button 
                onClick={closeDrawer}
                className="p-2 bg-slate-100 dark:bg-white/5 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors"
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

      {/* API Key Modal */}
      {isKeyModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 dark:bg-black/80 overlay-blur animate-fade-in" onClick={() => setIsKeyModalOpen(false)}></div>
          <div className="relative w-full max-w-md bg-white dark:bg-surface-dark border border-black/5 dark:border-white/10 rounded-3xl shadow-2xl p-8 animate-slide-up">
            <div className="flex items-center justify-between mb-8">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">API Settings</h3>
              <button 
                onClick={() => setIsKeyModalOpen(false)}
                className="p-2 bg-slate-100 dark:bg-white/5 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors"
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
