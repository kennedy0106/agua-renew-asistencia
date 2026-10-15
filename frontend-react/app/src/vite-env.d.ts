/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base del API. En desarrollo: http://localhost:8000 */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
