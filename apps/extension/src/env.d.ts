/// <reference types="vite/client" />

/**
 * Build-time configuration. Everything here is public and ends up in the shipped
 * JavaScript, so it must never hold a secret. See docs/cloud-protocol.md.
 */
interface ImportMetaEnv {
  /**
   * Your PigeonBox server's API origin for this build. Blank (always in release
   * builds): no server unless one is set in Settings → Advanced, and PigeonBox runs
   * on this computer only. Also the only website the build lets message it
   * (`externally_connectable`, for the server's dashboard).
   */
  readonly VITE_PIGEONBOX_CLOUD_API_URL?: string;
  /** Your PigeonBox server's tracker origin. */
  readonly VITE_PIGEONBOX_CLOUD_TRACKER_URL?: string;
  /**
   * Comma-separated earlier origins of the same server tracker (for example the
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
