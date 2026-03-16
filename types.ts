
export enum Speaker {
  USER = 'USER',
  MODEL = 'MODEL'
}

export interface TranscriptEntry {
  id: string;
  speaker: Speaker;
  text: string;
  translatedText?: string;
  timestamp: number;
  isComplete: boolean;
}

export interface LiveSessionState {
  isActive: boolean;
  isPaused: boolean;
  error: string | null;
}

export interface Language {
  code: string;
  name: string;
  flag: string;
}

export interface Voice {
  id: string;
  name: string;
  description: string;
  isCustom?: boolean;
  sampleUrl?: string;
}

export const AVAILABLE_VOICES: Voice[] = [
  { id: 'Zephyr', name: 'Zephyr', description: 'Clear and professional' },
  { id: 'Puck', name: 'Puck', description: 'Energetic and bright' },
  { id: 'Charon', name: 'Charon', description: 'Deep and calm' },
  { id: 'Kore', name: 'Kore', description: 'Soft and gentle' },
  { id: 'Fenrir', name: 'Fenrir', description: 'Strong and steady' },
];

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷' },
  { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
  { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
];