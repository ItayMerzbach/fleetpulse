const env = import.meta.env as Record<string, string | undefined>;
const apiBaseUrl = env.VITE_API_URL ?? 'http://localhost:3000';

export const config = {
  apiBaseUrl,
  wsUrl: env.VITE_WS_URL ?? apiBaseUrl.replace(/^http/, 'ws') + '/ws',
};
