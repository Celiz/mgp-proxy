/**
 * Resuelve el challenge de Cloudflare en esta máquina y le acerca el clearance
 * al proxy.
 *
 * Para qué: el challenge sólo lo pasa un navegador con display real (medido:
 * `--headless=new` no lo resuelve), pero la cookie `cf_clearance` queda atada a
 * la **IP pública** y al User-Agent, no al equipo. Entonces una PC en el WiFi de
 * casa puede resolverlo y mandárselo al proxy que corre en el teléfono (Termux),
 * que sale por esa misma IP y no tiene cómo abrir un navegador.
 *
 * Uso:
 *   npx tsx src/scripts/obtenerClearance.ts                      # imprime el JSON
 *   npx tsx src/scripts/obtenerClearance.ts http://192.168.0.20:4000
 *
 * El destino también sale de MGP_PROXY_URL, y el token de ADMIN_TOKEN.
 * Conviene dejarlo en una tarea programada cada ~20 minutos.
 */

import "dotenv/config";
import { obtenerClearanceConNavegador } from "../lib/mgpWeb.js";

async function main(): Promise<void> {
    const destino = process.argv[2] ?? process.env.MGP_PROXY_URL;
    const token = process.env.ADMIN_TOKEN;

    const clearance = await obtenerClearanceConNavegador();
    console.log(`✅ clearance obtenido — cookies: ${clearance.cookies.map((c) => c.name).join(", ")}`);
    console.log(`   UA: ${clearance.ua}`);
    if (clearance.expiraEn) {
        const dias = Math.round((clearance.expiraEn - Date.now()) / 86_400_000);
        console.log(`   vence: ${new Date(clearance.expiraEn).toISOString()} (${dias} días)`);
    }

    const payload = {
        cookies: clearance.cookies,
        ua: clearance.ua,
        at: clearance.at,
        expiraEn: clearance.expiraEn,
    };

    if (!destino) {
        console.log("\nSin destino: pasá la URL del proxy como argumento o definí MGP_PROXY_URL.");
        console.log("Payload para POST /admin/clearance:\n");
        console.log(JSON.stringify(payload, null, 2));
        return;
    }

    if (!token) {
        console.error("❌ Falta ADMIN_TOKEN (tiene que ser el mismo que el del proxy).");
        process.exitCode = 1;
        return;
    }

    const url = `${destino.replace(/\/+$/, "")}/admin/clearance`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        body: JSON.stringify(payload),
    });
    const body = await res.text();

    if (!res.ok) {
        console.error(`❌ ${url} respondió ${res.status}: ${body}`);
        process.exitCode = 1;
        return;
    }
    console.log(`✅ clearance entregado a ${url}`);
    console.log(`   ${body}`);
}

main().catch((e) => {
    console.error("❌", (e as Error).message);
    process.exit(1);
});
