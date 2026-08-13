// netlify/functions/chat.js
//
// Función de Netlify (formato v2 / streaming) que conecta el chat de Growee
// con la API de Anthropic, enriqueciendo el system prompt con las
// metodologías de metodologias.json que sean relevantes para el mensaje.
//
// VARIABLES DE ENTORNO NECESARIAS (Netlify > Site settings > Environment variables):
//   ANTHROPIC_API_KEY   -> tu clave de la API de Anthropic (console.anthropic.com)
//
// Esta función NUNCA debe llevar la API key en el código ni en el frontend.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const metodologias = JSON.parse(
  readFileSync(join(__dirname, 'metodologias.json'), 'utf-8')
);

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5'; // revisa docs.claude.com/en/docs/about-claude/models para el string vigente
const MAX_TOKENS = 1024;
const MAX_METODOLOGIAS_EN_CONTEXTO = 8;

// ── Selección simple por palabras clave (sin embeddings, sin base de datos externa) ──
// Compara las palabras del último mensaje del usuario con el nombre y el campo
// "cuando_usar" de cada metodología, y se queda con las más relevantes.
function seleccionarMetodologiasRelevantes(textoUsuario, modulo) {
  if (!textoUsuario) return [];
  const texto = textoUsuario.toLowerCase();
  const palabras = texto.match(/[a-záéíóúñ]{4,}/g) || [];

  const candidatas = metodologias.metodologias.filter((m) => {
    if (modulo === 'bienestar') return m.modulo === 'bienestar';
    if (modulo === 'coaching') return m.modulo === 'coaching';
    return true; // módulo "ambos" -> se buscan en las 200
  });

  const puntuadas = candidatas.map((m) => {
    // "cuando_usar" pesa más que "resumen": es el campo pensado para detectar la situación
    const campoPrincipal = (m.nombre + ' ' + m.cuando_usar).toLowerCase();
    const campoSecundario = m.resumen.toLowerCase();
    let score = 0;
    for (const palabra of palabras) {
      if (campoPrincipal.includes(palabra)) score += 2;
      else if (campoSecundario.includes(palabra)) score += 1;
    }
    return { ...m, score };
  });

  return puntuadas
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_METODOLOGIAS_EN_CONTEXTO);
}

function formatearContexto(lista) {
  if (!lista.length) return '';
  const bloques = lista
    .map(
      (m) =>
        `- ${m.nombre} (${m.autor}, ${m.anio}) — ${m.resumen} Úsala cuando: ${m.cuando_usar}`
    )
    .join('\n');
  return `\n\nCONTEXTO ADICIONAL — METODOLOGÍAS ENCONTRADAS EN LA BASE DE DATOS RELEVANTES PARA ESTE MENSAJE\nSi alguna de estas encaja mejor que las que ya tienes en tu lista de metodologías, puedes usarla y citarla por su nombre y autor. Si ninguna encaja bien, ignóralas y usa tu propio criterio.\n${bloques}`;
}

function extraerUltimoMensajeTexto(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  const ultimo = messages[messages.length - 1];
  if (!ultimo || ultimo.role !== 'user') return '';
  if (typeof ultimo.content === 'string') return ultimo.content;
  if (Array.isArray(ultimo.content)) {
    const bloqueTexto = ultimo.content.find((b) => b.type === 'text');
    return bloqueTexto ? bloqueTexto.text : '';
  }
  return '';
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'Falta configurar ANTHROPIC_API_KEY en las variables de entorno de Netlify.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'JSON inválido' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { messages, system, modulo } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'Falta el array "messages"' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ultimoMensaje = extraerUltimoMensajeTexto(messages);
  const relevantes = seleccionarMetodologiasRelevantes(ultimoMensaje, modulo);
  const systemFinal = (system || '') + formatearContexto(relevantes);

  const anthropicRes = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemFinal,
      messages,
      stream: true,
    }),
  });

  if (!anthropicRes.ok || !anthropicRes.body) {
    const errText = await anthropicRes.text().catch(() => '');
    return new Response(JSON.stringify({ error: 'Error llamando a Anthropic', detail: errText }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // El frontend ya sabe leer el formato SSE nativo de Anthropic
  // (busca "content_block_delta" con "text_delta"), así que reenviamos
  // el stream tal cual, sin transformarlo.
  return new Response(anthropicRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
};

export const config = {
  path: '/.netlify/functions/chat',
};
