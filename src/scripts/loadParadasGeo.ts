import fs from 'fs';
import 'dotenv/config';
import { upsertParadaGeo } from '../lib/analytics.js';

const raw = fs.readFileSync('src/data/mgp-static-dump.json', 'utf8');
const dump = JSON.parse(raw);
const paradasMap = new Map();

for (const lineKey in dump.byLinea) {
    const line = dump.byLinea[lineKey];
    if (line.recorrido && Array.isArray(line.recorrido.paradas)) {
        for (const p of line.recorrido.paradas) {
            if (p.id && p.lat && p.lng) {
                paradasMap.set(p.id, {
                    codigo: p.id,
                    nombre: p.label && p.label !== p.id ? p.label : undefined,
                    lat: p.lat,
                    lng: p.lng
                });
            }
        }
    }
}

const paradasArray = Array.from(paradasMap.values());
console.log(`[import] Encontradas ${paradasArray.length} paradas únicas con coordenadas en el dump.`);

async function run() {
    try {
        // Hacemos el upsert en batches de 500 para no saturar Supabase
        for (let i = 0; i < paradasArray.length; i += 500) {
            const chunk = paradasArray.slice(i, i + 500);
            await upsertParadaGeo(chunk);
        }
        console.log('[import] ¡Importación finalizada!');
    } catch (e) {
        console.error('[import] Error importando:', e);
    }
    process.exit(0);
}

run();
