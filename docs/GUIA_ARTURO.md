# Guía rápida para Arturo (en español)

## Correrlo en tu laptop (10 minutos)

1. Instala Node.js 22 desde nodejs.org si no lo tienes.
2. Descomprime el proyecto, abre una terminal en la carpeta y escribe:

   ```bash
   npm install
   cp .env.example .env
   npm start
   ```

3. Abre http://localhost:3000. Funciona sin claves, con datos simulados.
4. Para correr las pruebas: `npm test` (deben salir 10 "ok").

## Lo que te toca a ti (nadie más puede hacerlo)

- [ ] Elegir el nombre final. Cambié "Dispute Defender" porque **Worldpay/FIS ya tiene un producto llamado "Disputes Defender"**. Puse "Neutronova Disputes" (tu marca). Se cambia en `APP_NAME` dentro de `.env`.
- [ ] Revisar la licencia (`LICENSE`): dice "Copyright (c) 2026 Arturo". Agrega tu apellido si quieres.
- [ ] Sandbox: sigue `docs/SANDBOX_SETUP.md`. Pon tus claves solo en `.env`, nunca en el chat ni en GitHub.
- [ ] (Opcional) Clave de Anthropic en `ANTHROPIC_API_KEY`. Sin clave usa el motor de reglas, gratis, y la demo funciona igual.

- [ ] Subir a GitHub como repositorio público. El `.gitignore` ya excluye `.env` y `data/`.
- [ ] Desplegar en Render (el archivo `render.yaml` ya está listo) en modo simulado.
- [ ] Medir: en la pestaña Metrics, cronometra una respuesta hecha a mano y luego corre el agente en la misma disputa. Esos números van en el video.
- [ ] Grabar el video siguiendo `docs/VIDEO_SCRIPT.md` y pegar `docs/DEVPOST.md` en Devpost.

## Cuidar el gasto de IA

- Modelo por defecto: `claude-haiku-5-5`, el más barato. Solo cámbialo si de verdad hace falta.
- `AGENT_STYLE=economy` (por defecto): una sola llamada a Claude por disputa y solo cuando hace falta. Si la evidencia no alcanza (reembolso), no se llama a la IA.
- Los mismos datos nunca se pagan dos veces: la respuesta se reutiliza.
- `AI_MAX_CALLS_PER_DAY=25`: tope diario. Al llegar, sigue con el motor de reglas sin costo.
- La pestaña Metrics muestra llamadas y tokens usados hoy.
- Para grabar el video puedes poner `AGENT_STYLE=agent` (el agente decide qué herramientas usar, hace varias llamadas) y volver a `economy` al terminar.
- Pon también un límite de gasto mensual en tu consola de Anthropic, por si acaso.

## Qué es real y qué es simulado

- Real: el código del agente, las herramientas del PayPal Agent Toolkit, la llamada a `provide-evidence`, los webhooks, las pruebas.
- Simulado (modo mock): las disputas, pedidos y compradores. Todos inventados.
- Lo que no se probó todavía contra PayPal real: el modo Sandbox, porque necesita tus claves. Pruébalo primero con una disputa.
