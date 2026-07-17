import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  console.error('[supabase] SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY ve SUPABASE_SECRET_KEY gerekli (.env).');
}

/** Düşük yetki — Auth signUp / signIn (publishable) */
export const supabaseAuth = createClient(url || '', publishableKey || '', {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

/** Yüksek yetki — sunucu DB (secret, RLS bypass) */
export const supabase = createClient(url || '', secretKey || '', {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

export function publicAppUrl() {
  return (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}
