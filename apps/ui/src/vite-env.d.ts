/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the API in a split deployment, e.g. https://api.example.com.
   * Unset in development so requests stay relative and the Vite proxy handles
   * them. Must match the API's own UI_ORIGIN, or CORS preflight rejects
   * every request.
   */
  readonly VITE_API_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
