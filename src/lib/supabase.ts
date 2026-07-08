/**
 * Cliente Supabase singleton.
 *
 * Si SUPABASE_URL o SUPABASE_KEY no están configuradas, el módulo
 * exporta `null` y el resto del sistema sigue funcionando sin analytics
 * persistente.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;

let supabase: SupabaseClient | null = null;

if (url && key) {
    supabase = createClient(url, key, {
        auth: { persistSession: false },
    });
    console.log("[analytics] Supabase conectado ✅");
} else {
    console.warn(
        "[analytics] ⚠️  SUPABASE_URL/SUPABASE_KEY no configuradas — analytics deshabilitado",
    );
}

export { supabase };
