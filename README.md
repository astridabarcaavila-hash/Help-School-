# HELP SCHOOL v6 – NOVA interactiva

Aplicación web instalable (PWA) con ingreso simple por nombres, apellidos y nivel educativo.

## Novedades principales

- Botón flotante de NOVA visible desde toda la aplicación.
- Chat emergente para conversar sin abandonar tareas, agenda o mochila.
- Dictado por voz, lectura en voz alta y copia de respuestas.
- Botón «Preguntar a NOVA» dentro de cada tarea.
- Recomendaciones de NOVA según las tareas pendientes.
- Respuestas locales útiles cuando el servidor no está disponible.
- Backend seguro en `api/` para conectar una IA real mediante Groq.
- Filtros de protección aplicados en el navegador y en el servidor.

## Publicación

La interfaz puede publicarse en GitHub Pages. Para IA completa, publica el mismo repositorio en Vercel y coloca la dirección del servidor en `config.js`. La clave `GROQ_API_KEY` debe configurarse únicamente como variable de entorno de Vercel.

## Acceso

El estudiante ingresa únicamente con nombres, apellidos y nivel. Los datos se guardan localmente en el dispositivo.
