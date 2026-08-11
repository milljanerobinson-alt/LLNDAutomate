import { createClient } from '@supabase/supabase-js';

export interface InitialAuthCallback {
  type: string | null;
  errorCode: string | null;
}

// Capture only non-sensitive callback context before supabase-js consumes and
// removes the implicit-flow fragment. Access/refresh tokens are never copied.
const initialAuthCallback: InitialAuthCallback = (() => {
  if (typeof window === 'undefined') return { type: null, errorCode: null };
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return {
    type: params.get('type'),
    errorCode: params.get('error_code') ?? params.get('error'),
  };
})();

export function getInitialAuthCallback(): InitialAuthCallback {
  return initialAuthCallback;
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export function createQuizClient(token: string) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      headers: { 'x-quiz-token': token },
    },
  });
}
