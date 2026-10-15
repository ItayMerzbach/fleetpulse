const env = import.meta.env as Record<string, string | undefined>;
const apiBaseUrl = env.VITE_API_URL ?? 'http://localhost:3000';

export const config = {
  apiBaseUrl,
  wsUrl: env.VITE_WS_URL ?? apiBaseUrl.replace(/^http/, 'ws') + '/ws',
  /** Optional. Without it the dashboard uses the offline grid map. */
  googleMapsApiKey: env.VITE_GOOGLE_MAPS_API_KEY?.trim() || null,
  /** AdvancedMarkers need a Map ID; Google's DEMO_MAP_ID works for development. */
  googleMapsMapId: env.VITE_GOOGLE_MAPS_MAP_ID?.trim() || 'DEMO_MAP_ID',
};
