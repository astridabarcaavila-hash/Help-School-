# Activar NOVA como inteligencia artificial

La interfaz ya conversa en modo local. Para respuestas abiertas y completas desde cualquier celular, publica el backend `api/` en Vercel.

## 1. Publicar el repositorio en Vercel

1. Importa el mismo repositorio de HELP SCHOOL en Vercel.
2. En **Settings → Environment Variables**, crea:
   - `GROQ_API_KEY`: tu clave privada.
   - `GROQ_MODEL`: `llama-3.3-70b-versatile`.
   - `ALLOWED_ORIGINS`: `https://brunocastillo948-ai.github.io`.
3. Realiza un nuevo despliegue.

## 2. Conectar GitHub Pages con NOVA

En `config.js`, reemplaza `/api` por la dirección de Vercel:

```javascript
window.HELP_SCHOOL_CONFIG = Object.freeze({
  NOVA_API_BASE: "https://TU-PROYECTO.vercel.app/api",
  SCHOOL_NAME: "HELP SCHOOL",
  LOCALE: "es-PE"
});
```

Nunca coloques `GROQ_API_KEY` en `config.js`, `app.js` o GitHub Pages. La clave solo debe permanecer en las variables privadas del servidor.

## 3. Comprobar

En HELP SCHOOL entra a **Perfil → Estado de NOVA → Probar**. Debe aparecer **IA conectada**.
