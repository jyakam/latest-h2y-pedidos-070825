import 'dotenv/config'
import { OpenAI } from 'openai'

//TT MODULOS
import { ENUM_IA_RESPUESTAS } from './IAEnumRespuestas.mjs'
import { DetectarFuncion, FuncionesIA } from './funcionesIA.mjs'
import { ObtenerHistorial } from './historial.mjs'
import { Notificar, ENUM_NOTI } from '../../config/notificaciones.mjs'
import { BOT, MENSAJES } from '../../config/bot.mjs'

//TT AGREGAR CLAVE
function OpenIA() {
  return new OpenAI({
    apiKey: BOT.KEY_IA || process.env.OPENAI_API_KEY
  })
}

//TT LLAMAR IA
export async function EnviarTextoOpenAI(msj, userId, guion, estado, llamada = null) {
  try {
    const _historial = ObtenerHistorial(userId, guion, estado)

    // Asegurar system prompt
    if (!_historial.length || !_historial[0] || _historial[0].role !== 'system') {
      _historial.unshift({
        role: 'system',
        content: 'Eres un asistente virtual que ayuda a los clientes a resolver sus dudas y procesar solicitudes.'
      });
    }

    // Añadir mensaje del usuario o llamadas preconstruidas
    if (!llamada) {
      _historial.push({ role: 'user', content: msj })
    } else {
      if (Array.isArray(llamada)) {
        _historial.push(...llamada)
      } else if (typeof llamada === 'object') {
        _historial.push(llamada)
      }
    }

    // Tomar últimos turnos relevantes
    const mensajesUserAssistant = _historial.slice(1).filter(
      m => m.role === 'user' || m.role === 'assistant'
    )
    const ultimosTurnos = mensajesUserAssistant.slice(-8)
    const historialFinal = [_historial[0], ...ultimosTurnos]

    const openai = OpenIA()

    // Construcción segura del request: usar max_completion_tokens (no max_tokens)
    const request = {
      model: BOT.MODELO_IA,
      messages: historialFinal,
      temperature: BOT.TEMPERATURA
    }
    if (BOT.TOKENS) {
      request.max_completion_tokens = BOT.TOKENS
    }

    // Agregar funciones si corresponde
    const funciones = FuncionesIA(guion)
    if (Array.isArray(funciones) && funciones.length > 0) {
      request.functions = funciones
      request.function_call = 'auto'
    }

    // ================= LOGS ROBUSTOS =================
    console.log('================= [PROMPT ENVIADO A OPENAI] =================');
    console.log(`[DEBUG] Historial final con ${historialFinal.length} mensajes.`);

    let totalChars = 0;
    historialFinal.forEach((m, idx) => {
      let preview = '';
      let contentLength = 0;

      // Si es texto sencillo
      if (typeof m.content === 'string') {
        preview = m.content.substring(0, 100).replace(/\n/g, ' ');
        contentLength = m.content.length;
      }
      // Si es array (p. ej. mensajes con partes tipo imagen + texto)
      else if (Array.isArray(m.content)) {
        preview = '[Mensaje con imagen]';
        const textPart = m.content.find(p => p.type === 'text');
        if (textPart && typeof textPart.text === 'string') {
          contentLength = textPart.text.length;
        }
      }

      totalChars += contentLength;
      const dots = contentLength > 100 ? '... [truncado]' : '';
      console.log(`[${idx}] (${m.role}) [${contentLength} chars]: "${preview}${dots}"`);
    });

    console.log('Longitud total del prompt (caracteres):', totalChars);
    console.log('===========================================================');
    // ========================================

    // Llamada principal a la API (chat completions)
    const completion = await openai.chat.completions.create(request)

    const message = completion.choices?.[0]?.message
    if (!message) throw new Error('❌ La IA no devolvió ninguna respuesta válida.')

    // ---------- Helpers para extracción y parseo ----------
    const cleanSmartQuotes = (s) => (typeof s === 'string' ? s.replace(/[\u201C\u201D\u2018\u2019]/g, '"') : s)

    const extractTextFromMessage = (msg) => {
      if (!msg) return ''
      if (typeof msg === 'string') return msg
      if (typeof msg.content === 'string') return msg.content
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'string') return part
          if (part?.text && typeof part.text === 'string') return part.text
          if (part?.content && typeof part.content === 'string') return part.content
        }
        return msg.content.map(p => (p?.text || p?.content || '')).filter(Boolean).join(' ')
      }
      if (msg?.text && typeof msg.text === 'string') return msg.text
      if (msg?.content?.[0]?.text) return msg.content[0].text
      return ''
    }

    const safeParseJson = (text) => {
      if (!text || typeof text !== 'string') return null
      let t = cleanSmartQuotes(text).replace(/\uFFFD/g, '')
      try {
        return JSON.parse(t)
      } catch (e) {
        const start = t.indexOf('{')
        const end = t.lastIndexOf('}')
        if (start !== -1 && end !== -1 && end > start) {
          const maybe = t.substring(start, end + 1)
          try { return JSON.parse(maybe) } catch (e2) { /* continuar */ }
        }
        return null
      }
    }
    // -------------------------------------------------------

    // Extraer texto crudo y parsear si es posible
    let rawText = extractTextFromMessage(message).trim()
    let parsed = safeParseJson(rawText)

    // Si la IA propuso una function_call (cuando se usan funciones)
    const functionCall = message?.function_call ?? completion.choices?.[0]?.message?.function_call
    if (functionCall && !parsed) {
      // Enviar a DetectarFuncion la estructura de function_call para que tu lógica la procese
      const payloadForDetectar = { function_call }
      const respuestaFromFunc = await DetectarFuncion(payloadForDetectar, userId, guion, estado)
      _historial.push({ role: 'assistant', content: respuestaFromFunc, raw_model_text: JSON.stringify(functionCall) })
      return { respuesta: respuestaFromFunc, tipo: ENUM_IA_RESPUESTAS.TEXTO }
    }

    // Si no vino JSON y tu flujo depende de JSON, reintentar una vez pidiendo SOLO JSON
    if (!parsed) {
      console.warn('⚠️ Respuesta no es JSON válido, intentando reintento estricto (solo JSON)...')
      const retryMessages = [
        ...historialFinal,
        {
          role: 'user',
          content:
            'ATENCIÓN: RESPONDE SOLO CON JSON VÁLIDO. NO AGREGUES TEXTO ADICIONAL NI EMOJIS. ' +
            'Devuelve únicamente el JSON sin explicaciones. Si no puedes, responde {"error":"no_info"}.'
        }
      ]
      const retryReq = {
        ...request,
        messages: retryMessages
      }
      try {
        const retryResp = await openai.chat.completions.create(retryReq)
        const retryMsg = retryResp.choices?.[0]?.message
        const retryText = extractTextFromMessage(retryMsg).trim()
        const retryParsed = safeParseJson(retryText)
        if (retryParsed) {
          parsed = retryParsed
          rawText = retryText
        } else {
          console.error('❌ Reintento no devolvió JSON válido. Texto recibido:', retryText)
        }
      } catch (retryErr) {
        console.error('💥 Error en reintento (JSON estricto):', retryErr)
      }
    }

    // Preparar payload para DetectarFuncion: preferimos objeto JSON, sino texto crudo, sino el objeto message
    const payloadForDetectar = parsed ?? rawText ?? message

    const respuesta = await DetectarFuncion(payloadForDetectar, userId, guion, estado)

    // Guardar en historial: respuesta final + raw para auditoría
    _historial.push({ role: 'assistant', content: respuesta, raw_model_text: rawText })

    return { respuesta, tipo: ENUM_IA_RESPUESTAS.TEXTO }
  } catch (error) {
    console.error('💥 TXT - Error al llamar a la API de OpenAI:', error)
    const msj = '⚠️ No es posible conectar con *OpenAI (TXT)*. Revisa la clave de API, tokens o el saldo de la cuenta.'
    Notificar(ENUM_NOTI.ERROR, { msj })
    return { respuesta: MENSAJES.ERROR || '❌ No pude procesar tu solicitud, por favor intentá más tarde.', tipo: ENUM_IA_RESPUESTAS.TEXTO }
  }
}
