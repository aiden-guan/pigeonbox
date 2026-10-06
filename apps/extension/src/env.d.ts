/// <reference types="vite/client" />

/**
 * Build-time configuration. Everything here is public and ends up in the shipped
 * JavaScript, so it must never hold a secret. See docs/cloud-protocol.md.
 */
interface ImportMetaEnv {
  /** PigeonBox Cloud API origin for this build. Blank: Cloud is unavailable and Local is the only mode. */
  readonly VITE_PIGEONBOX_CLOUD_API_URL?: string;
  /** Hosted tracker origin used in Cloud mode. */
  readonly VITE_PIGEONBOX_CLOUD_TRACKER_URL?: string;
  /**
   * Comma-separated earlier origins of the same hosted tracker (for example the
   * workers.dev address before a custom domain). Mail already sent carries those
   * pixel URLs; listing them keeps the sender's own views of that mail suppressed.
   */
  readonly VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS?: string;
  /** "false" hides experimental features (ChatGPT web sign-in). Release builds set it. */
  readonly VITE_PIGEONBOX_EXPERIMENTAL?: string;
  /** Local dev-reload helper origin. Source builds default it; release builds leave it blank. */
  readonly VITE_PIGEONBOX_DEV_REBUILD_URL?: string;
  /** "1" in release builds (set by vite.config.ts from PIGEONBOX_RELEASE). */
  readonly VITE_PIGEONBOX_RELEASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
