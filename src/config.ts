const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

export const config = {
  apiBaseUrl,
  wsUrl: (import.meta.env.VITE_WS_URL as string | undefined) ?? apiBaseUrl.replace(/^http/, 'ws') + '/ws',
};
