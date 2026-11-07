/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_MODE?: string;
  readonly VITE_PUBLIC_MODE?: string;
  readonly VITE_PUBLIC_MOCK_AI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
