import type { ModelInfo } from '../types/settings'
import type { SavedProvider } from '../types/provider'

export const GROK_OFFICIAL_PROVIDER_ID = 'grok-official'
export const GROK_OFFICIAL_DEFAULT_MODEL_ID = 'grok-4.5'
export const GROK_OFFICIAL_PROVIDER_NAME = 'Grok Official'
export const GROK_OFFICIAL_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'

/** Shell row for Grok official account/quota panel (tokens live in grok-oauth.json). */
export const GROK_OFFICIAL_PROVIDER_SHELL: SavedProvider = {
  id: GROK_OFFICIAL_PROVIDER_ID,
  presetId: GROK_OFFICIAL_PROVIDER_ID,
  name: GROK_OFFICIAL_PROVIDER_NAME,
  apiKey: '',
  baseUrl: GROK_OFFICIAL_BASE_URL,
  apiFormat: 'openai_chat',
  runtimeKind: 'grok_oauth',
  models: {
    main: GROK_OFFICIAL_DEFAULT_MODEL_ID,
    haiku: GROK_OFFICIAL_DEFAULT_MODEL_ID,
    sonnet: GROK_OFFICIAL_DEFAULT_MODEL_ID,
    opus: GROK_OFFICIAL_DEFAULT_MODEL_ID,
  },
  accountInfo: {
    type: 'oauth/grok',
    accountLabel: 'Grok OAuth',
  },
}

export const GROK_OFFICIAL_MODELS: ModelInfo[] = [
  {
    id: GROK_OFFICIAL_DEFAULT_MODEL_ID,
    name: 'Grok 4.5',
    description: 'Grok frontier text model',
    context: '500000',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'grok-composer-2.5-fast',
    name: 'Composer 2.5',
    description: 'Grok coding model',
    context: '200000',
    supportedReasoningEfforts: [],
  },
]
