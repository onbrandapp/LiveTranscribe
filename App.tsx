
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Speaker, TranscriptEntry, LiveSessionState, SUPPORTED_LANGUAGES, Language } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audio-helpers';
import TranscriptionList from './components/TranscriptionList';
import Visualizer from './components/Visualizer';

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

  const [isTranslationEnabled, setIsTranslationEnabled] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState<Language>(SUPPORTED_LANGUAGES[0]); // English default
  const [isDrawerRendered, setIsDrawerRendered] = useState(false);
  const [isDrawerClosing, setIsDrawerClosing] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  
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

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

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

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  const saveApiKey = () => {
    setApiKey(tempKey);
    localStorage.setItem('gemini_api_key', tempKey);
    setIsKeyModalOpen(false);
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

      const systemInstruction = isTranslationEnabled 
        ? `You are a high-fidelity real-time audio translator. 
           Your ONLY job is to listen to the user and translate their speech into ${targetLanguage.name}.
           - Provide ONLY the translation in your audio output.
           - Ensure the transcription matches your spoken translation exactly.
           - Include proper punctuation and capitalization.`
        : `You are a helpful and concise AI conversationalist. 
           - Respond naturally and briefly to the user.
           - Ensure all transcriptions include proper punctuation and capitalization.
           - Your primary goal is to provide useful information while being transcribed in real-time.`;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction,
        },
        callbacks: {
          onopen: () => {
            setSessionState({ isActive: true, isPaused: false, error: null });
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              if (sessionState.isPaused) return;
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

  return (
    <div className="min-h-screen flex flex-col items-center p-4 transition-colors duration-500 bg-white dark:bg-matte selection:bg-banana selection:text-black">
      <header className="w-full max-w-7xl flex items-center justify-between mb-4 border-b border-black/5 dark:border-white/5 pb-4">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-banana rounded-xl flex items-center justify-center shadow-lg shadow-banana/20">
            <svg className="w-6 h-6 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tighter text-slate-900 dark:text-white uppercase italic">
              Gemini Live <span className="text-banana">Transcribe</span>
            </h1>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${sessionState.isActive ? 'bg-banana animate-pulse' : 'bg-slate-200 dark:bg-white/10'}`}></span>
              <span className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-widest">
                {sessionState.isActive ? (sessionState.isPaused ? 'Paused' : 'Active') : 'Disconnected'}
              </span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <button 
            onClick={() => {
              setTempKey(apiKey);
              setIsKeyModalOpen(true);
            }}
            className="p-2.5 bg-slate-100 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-xl text-slate-600 dark:text-white/50 hover:bg-slate-200 dark:hover:bg-white/10 transition-all flex items-center gap-2"
            title="API Settings"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            <span className="text-[10px] font-bold uppercase tracking-widest hidden sm:inline">Key</span>
          </button>
          <button 
            onClick={toggleTheme}
            className="p-2.5 bg-slate-100 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-xl text-slate-600 dark:text-white/50 hover:bg-slate-200 dark:hover:bg-white/10 transition-all"
          >
            {theme === 'dark' ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M14 12a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
            )}
          </button>
        </div>
      </header>

      <main className="w-full max-w-7xl flex-1 flex flex-col md:flex-row gap-6 h-[calc(100vh-140px)]">
        {/* Controls Column */}
        <div className="w-full md:w-72 flex flex-col gap-4">
          <div className="bg-slate-50 dark:bg-surface-dark border border-black/5 dark:border-white/10 rounded-2xl p-5 shadow-sm space-y-5">
            {/* Translation Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-[10px] font-black text-slate-400 dark:text-white/30 uppercase tracking-[0.2em]">Live Translation</label>
                <p className="text-[10px] text-slate-400 dark:text-white/20">Beta Feature</p>
              </div>
              <button 
                onClick={() => setIsTranslationEnabled(!isTranslationEnabled)}
                disabled={sessionState.isActive}
                className={`w-10 h-6 rounded-full transition-all relative ${isTranslationEnabled ? 'bg-banana' : 'bg-slate-200 dark:bg-white/10'} ${sessionState.isActive ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white dark:bg-matte shadow-sm transition-all ${isTranslationEnabled ? 'left-5' : 'left-1'}`}></div>
              </button>
            </div>

            <div className={`${!isTranslationEnabled ? 'opacity-30 grayscale pointer-events-none' : 'opacity-100'} transition-all duration-300`}>
              <label className="block text-[10px] font-black text-slate-400 dark:text-white/30 uppercase mb-3 tracking-[0.2em]">Translation Target</label>
              <button 
                disabled={!isTranslationEnabled || sessionState.isActive}
                onClick={openDrawer}
                className="w-full flex items-center justify-between bg-white dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-xl p-3 text-sm font-bold text-slate-700 dark:text-white hover:border-banana/50 transition-all disabled:opacity-50"
              >
                <span className="flex items-center gap-3">
                  <span className="text-xl">{targetLanguage.flag}</span>
                  <span>{targetLanguage.name}</span>
                </span>
                {!sessionState.isActive && isTranslationEnabled && <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>}
              </button>
            </div>
          </div>

          <Visualizer 
            isActive={sessionState.isActive}
            isUserSpeaking={isUserSpeaking}
            isModelSpeaking={isModelSpeaking}
            theme={theme}
          />

          <div className="mt-auto space-y-3">
            {!sessionState.isActive ? (
              <button 
                onClick={startSession}
                className="w-full py-4 bg-banana hover:bg-[#EED125] active:scale-[0.98] transition-all rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-banana/10 text-black"
              >
                Start Live Transcribe
              </button>
            ) : (
              <div className="flex flex-col gap-3">
                <button 
                  onClick={togglePause}
                  className={`w-full py-4 rounded-2xl font-black text-xs uppercase tracking-widest border-2 transition-all flex items-center justify-center gap-3 ${
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
                  className="w-full py-4 bg-white dark:bg-white/5 border border-red-500/20 text-red-500 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-red-500/5 transition-all"
                >
                  End Session
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Transcript Feed Column */}
        <div className="flex-1 bg-slate-50 dark:bg-surface-dark rounded-3xl border border-black/5 dark:border-white/5 flex flex-col overflow-hidden shadow-2xl relative">
          <div className="px-6 py-4 border-b border-black/5 dark:border-white/5 flex justify-between items-center bg-white/80 dark:bg-surface-dark/80 backdrop-blur-xl">
            <h2 className="text-[10px] font-black text-slate-400 dark:text-white/40 uppercase tracking-[0.4em]">Transcript Feed</h2>
            <button onClick={() => setTranscripts([])} className="text-[9px] font-black text-slate-300 dark:text-white/20 hover:text-red-500 uppercase tracking-widest transition-colors">Clear</button>
          </div>
          <TranscriptionList transcripts={transcripts} />
        </div>
      </main>

      {/* Language Modal */}
      {isDrawerRendered && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className={`absolute inset-0 bg-black/60 dark:bg-black/80 overlay-blur ${isDrawerClosing ? 'animate-fade-out' : 'animate-fade-in'}`} onClick={closeDrawer}></div>
          <div className={`relative w-full max-w-lg bg-white dark:bg-surface-dark border border-black/5 dark:border-white/10 rounded-3xl shadow-2xl p-6 ${isDrawerClosing ? 'animate-slide-down' : 'animate-slide-up'}`}>
            <h3 className="text-lg font-black text-slate-900 dark:text-white uppercase tracking-tight mb-6">Select Translation Language</h3>
            <div className="grid grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto custom-scrollbar pr-2">
              {SUPPORTED_LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => { setTargetLanguage(lang); closeDrawer(); }}
                  className={`flex items-center gap-4 p-4 rounded-2xl border transition-all ${
                    targetLanguage.code === lang.code ? 'bg-banana border-banana text-black' : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/5 text-slate-500 dark:text-white/40 hover:bg-slate-100 dark:hover:bg-white/10'
                  }`}
                >
                  <span className="text-2xl">{lang.flag}</span>
                  <span className="text-[11px] font-black uppercase tracking-widest">{lang.name}</span>
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
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 bg-banana rounded-2xl flex items-center justify-center shadow-lg shadow-banana/20">
                <svg className="w-6 h-6 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase tracking-tight">API Settings</h3>
                <p className="text-[10px] font-bold text-slate-400 dark:text-white/30 uppercase tracking-widest">Gemini API Configuration</p>
              </div>
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
                  className="flex-1 py-4 bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/50 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 dark:hover:bg-white/10 transition-all"
                >
                  Cancel
                </button>
                <button 
                  onClick={saveApiKey}
                  className="flex-1 py-4 bg-banana hover:bg-[#EED125] text-black rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-banana/10 transition-all"
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
