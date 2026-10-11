/**
 * Live captions with on-device translation.
 *
 * Mount contract (Room.tsx):
 *   const captions = useCaptions({ signaling, roomId: callRoomId, localStream, micEnabled,
 *                                  partnerLanguage: state.partner?.language ?? null,
 *                                  viewerLanguage: profile.language });   // once per room screen
 *   <CaptionsToggle captions={captions} />     // in the call action bar
 *   <CaptionsOverlay captions={captions} />    // inside the remote video tile (absolute, bottom)
 *
 * Props are documented in each component's file header. Strings live in the
 * `spark` i18n namespace under `captions.*`.
 *
 * Browser support is decided by feature detection at runtime:
 * - SpeechRecognition (captions/speech.ts): the toggle is disabled without it.
 * - Translator (captions/translator.ts): without it, or for an unavailable
 *   pair, the partner's text shows in the original language with a tag.
 */
export { CaptionsOverlay, type CaptionsOverlayProps } from "./CaptionsOverlay";
export { CaptionsToggle, type CaptionsToggleProps } from "./CaptionsToggle";
export { useCaptions, CAPTIONS_KEY, type CaptionsHandle, type UseCaptionsOptions } from "./useCaptions";
